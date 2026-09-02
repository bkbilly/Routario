"""
SIP Voice Call Notification Channel
Places a SIP call with a TTS message (or pre-recorded audio) when an alert fires.

URL format:
    sip://username:password@server:port/extension?repeat=3&pause=2&tts=gtts&lang=en

Query parameters (all optional):
    file    — path to a pre-recorded WAV file to play instead of TTS
              e.g. file=/audio/alert.wav
    repeat  — how many times to repeat the message    (default: 1)
    pause   — seconds of silence between repeats      (default: 2)
    tts     — TTS engine: "gtts" or "espeak"          (default: gtts, ignored if file= set)
    lang    — BCP-47 language code                    (default: en,   ignored if file= set)

Examples:
    # Pre-recorded file, repeat 3 times
    sip://user:pass@192.168.1.100/1001?file=/audio/alert.wav&repeat=3

    # TTS (default behaviour when file= is absent)
    sip://user:pass@192.168.1.100/1001?repeat=2&lang=en
"""

import asyncio
import base64
import hashlib
import logging
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import wave
from urllib.parse import urlparse, parse_qs

import httpx
from gtts import gTTS
from pyVoIP.VoIP import VoIPPhone, CallState, InvalidStateError

from .base import BaseNotificationChannel

DEFAULT_GEMINI_DISPATCHER_INSTRUCTION = (
    "You are a professional telematics voice dispatcher. "
    "Read the vehicle alert clearly and directly in an alert warning tone without preamble."
)

GEMINI_LANG_NAMES = {
    "en": "English", "sq": "Albanian", "ar": "Arabic", "bg": "Bulgarian",
    "zh": "Chinese", "hr": "Croatian", "cs": "Czech", "da": "Danish",
    "nl": "Dutch", "et": "Estonian", "fi": "Finnish", "fr": "French",
    "de": "German", "el": "Greek", "he": "Hebrew", "hi": "Hindi",
    "hu": "Hungarian", "id": "Indonesian", "it": "Italian", "ja": "Japanese",
    "ko": "Korean", "no": "Norwegian", "pl": "Polish", "pt": "Portuguese",
    "ro": "Romanian", "ru": "Russian", "sr": "Serbian", "sk": "Slovak",
    "es": "Spanish", "sv": "Swedish", "th": "Thai", "tr": "Turkish",
    "uk": "Ukrainian", "vi": "Vietnamese"
}

logger = logging.getLogger(__name__)


class SipChannel(BaseNotificationChannel):
    """Delivers voice alarm calls over SIP / VoIP with TTS playback."""

    @classmethod
    def matches(cls, url: str) -> bool:
        return url.strip().lower().startswith("sip://")

    async def send(self, url: str, title: str, message: str, attachments: list[str] | None = None) -> bool:
        """
        Initiate an outbound SIP call to `url` and speak `message`.
        """
        params = self._parse_url(url)
        if not params:
            return False

        prerecorded = params.get("file")

        if prerecorded:
            # ── Pre-recorded file ─────────────────────────────────
            if not os.path.isfile(prerecorded):
                logger.error(f"SIP: pre-recorded file not found: {prerecorded}")
                return False
            logger.info(
                f"SIP: calling {params['extension']}@{params['server']} "
                f"(repeat={params['repeat']}, file={prerecorded})"
            )
            return await asyncio.get_event_loop().run_in_executor(
                None, self._call, params, prerecorded
            )

        # ── TTS (default) ─────────────────────────────────────────
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            audio_path = f.name

        try:
            tts_engine = params.get("tts", "gtts")
            tts_ok = await asyncio.get_event_loop().run_in_executor(
                None,
                self._generate_tts,
                message,
                tts_engine,
                params,
                audio_path,
            )
            if not tts_ok:
                logger.error("SIP: TTS generation failed")
                return False

            logger.info(
                f"SIP: calling {params['extension']}@{params['server']} "
                f"(repeat={params['repeat']}, tts={tts_engine})"
            )
            return await asyncio.get_event_loop().run_in_executor(
                None, self._call, params, audio_path
            )
        finally:
            try:
                os.unlink(audio_path)
            except OSError:
                pass

    # ── URL parser ────────────────────────────────────────────────

    @staticmethod
    def _parse_url(url: str) -> dict | None:
        """
        Parse a SIP notification target URL.
        Accepts:
            sip://user:pass@host:port/extension?params...
            1001  (plain extension — server/creds must be in config)
        """
        if not url:
            return None

        # Handle plain extension shorthand
        if "://" not in url:
            try:
                from core.config import get_settings
                s = get_settings()
                if not getattr(s, "voip_enabled", False):
                    logger.warning("SIP: voip_enabled is False in system settings")
                    return None
                if not getattr(s, "voip_server", "") or not getattr(s, "voip_username", ""):
                    logger.warning("SIP: SIP server or username not configured in settings")
                    return None
                tts_eng = getattr(s, "voip_tts_engine", "gtts")
                return {
                    "username":  s.voip_username,
                    "password":  s.voip_password,
                    "server":    s.voip_server,
                    "port":      getattr(s, "voip_port", 5060),
                    "extension": url.strip(),
                    "repeat":    getattr(s, "voip_repeat", 1),
                    "pause":     getattr(s, "voip_pause_seconds", 2),
                    "tts":       tts_eng,
                    "lang":      getattr(s, "voip_gemini_language", "en") if tts_eng == "gemini" else getattr(s, "voip_gtts_language", "en"),
                    "voice":     getattr(s, "voip_espeak_voice", "en") if tts_eng == "espeak" else getattr(s, "voip_gemini_voice", "Aoede"),
                    "speed":     getattr(s, "voip_espeak_speed", 150),
                    "pitch":     getattr(s, "voip_espeak_pitch", 50),
                    "model":     getattr(s, "voip_gemini_model", "gemini-2.5-flash-preview-tts"),
                    "key":       getattr(s, "voip_gemini_api_key", "") or getattr(s, "llm_gemini_api_key", ""),
                    "file":      None,
                }
            except Exception as e:
                logger.error(f"SIP: failed reading config for extension '{url}': {e}")
                return None

        try:
            parsed = urlparse(url)
            qs = parse_qs(parsed.query)

            def _int(key, default):
                try:
                    return int(qs[key][0])
                except (KeyError, ValueError, IndexError):
                    return default

            def _str(key, default):
                try:
                    return qs[key][0]
                except (KeyError, IndexError):
                    return default

            return {
                "username":  parsed.username or "",
                "password":  parsed.password or "",
                "server":    parsed.hostname or "",
                "port":      parsed.port or 5060,
                "extension": parsed.path.lstrip("/"),
                "repeat":    _int("repeat", 1),
                "pause":     _int("pause",  2),
                "tts":       _str("tts",    "gtts"),
                "lang":      _str("lang",   "en"),
                "voice":     _str("voice",  None),
                "speed":     _int("speed",  150),
                "pitch":     _int("pitch",  50),
                "model":     _str("model",  "gemini-2.5-flash-preview-tts"),
                "key":       _str("key",    None),
                "file":      _str("file",   None),
            }
        except Exception as e:
            logger.error(f"SIP: failed to parse URL '{url}': {e}")
            return None

    # ── TTS & Caching ─────────────────────────────────────────────

    @staticmethod
    def _compute_cache_key(text: str, engine: str, params: dict) -> str:
        """Compute a deterministic hash for caching synthesized TTS audio files."""
        eng = (engine or "gtts").lower().strip()
        clean_text = (text or "").strip()
        if eng == "espeak":
            voice = params.get("voip_espeak_voice") or params.get("espeak_voice") or params.get("voice") or "en"
            speed = params.get("voip_espeak_speed") or params.get("espeak_speed") or params.get("speed") or 150
            pitch = params.get("voip_espeak_pitch") or params.get("espeak_pitch") or params.get("pitch") or 50
            raw = f"espeak|{voice}|{speed}|{pitch}|{clean_text}"
        elif eng == "gemini":
            model = params.get("voip_gemini_model") or params.get("gemini_model") or params.get("model") or "gemini-2.5-flash-preview-tts"
            voice = params.get("voip_gemini_voice") or params.get("gemini_voice") or params.get("voice") or "Aoede"
            lang = params.get("voip_gemini_language") or params.get("gemini_language") or params.get("lang") or "en"
            raw = f"gemini|{model}|{voice}|{lang}|{clean_text}"
        else:
            lang = params.get("voip_gtts_language") or params.get("gtts_language") or params.get("lang") or "en"
            raw = f"gtts|{lang}|{clean_text}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]

    @staticmethod
    def _generate_tts(text: str, engine: str, params: dict, output_path: str) -> bool:
        eng = (engine or "gtts").lower().strip()
        cache_dir = Path("web/uploads/tts")
        cache_key = SipChannel._compute_cache_key(text, eng, params)
        cached_file = cache_dir / f"{cache_key}.wav"

        # 1. Check disk cache
        if cached_file.is_file() and cached_file.stat().st_size > 0:
            try:
                os.utime(cached_file, None)  # Refresh LRU access timestamp
                shutil.copyfile(cached_file, output_path)
                logger.info(f"SIP: Reused cached TTS audio ({cached_file.name})")
                return True
            except Exception as e:
                logger.warning(f"SIP: Failed reading cached TTS file: {e}")

        # 2. Synthesize audio on cache miss
        success = False
        if eng == "espeak":
            voice = params.get("voip_espeak_voice") or params.get("espeak_voice") or params.get("voice") or params.get("lang") or "en"
            speed = params.get("voip_espeak_speed") or params.get("espeak_speed") or params.get("speed") or 150
            pitch = params.get("voip_espeak_pitch") or params.get("espeak_pitch") or params.get("pitch") or 50
            success = SipChannel._tts_espeak(text, voice, speed, pitch, output_path)
        elif eng == "gemini":
            api_key = params.get("voip_gemini_api_key") or params.get("gemini_api_key") or params.get("key") or ""
            if not api_key:
                try:
                    from core.config import get_settings
                    s = get_settings()
                    api_key = getattr(s, "voip_gemini_api_key", "") or getattr(s, "llm_gemini_api_key", "") or ""
                except Exception:
                    pass
            model = params.get("voip_gemini_model") or params.get("gemini_model") or params.get("model") or "gemini-2.5-flash-preview-tts"
            voice = params.get("voip_gemini_voice") or params.get("gemini_voice") or params.get("voice") or "Aoede"
            lang = params.get("voip_gemini_language") or params.get("gemini_language") or params.get("lang") or "en"
            success = SipChannel._tts_gemini(text, api_key, model, voice, lang, output_path)
        else:  # gtts default
            lang = params.get("voip_gtts_language") or params.get("gtts_language") or params.get("lang") or "en"
            success = SipChannel._tts_gtts(text, lang, output_path)

        # 3. Store into cache on success
        if success and os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            try:
                cache_dir.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(output_path, cached_file)
                logger.info(f"SIP: Cached generated TTS audio ({cached_file.name})")
            except Exception as e:
                logger.warning(f"SIP: Failed caching generated TTS audio: {e}")

        return success

    @staticmethod
    def _tts_gtts(text: str, lang: str, output_path: str) -> bool:
        try:
            mp3_path = output_path.replace(".wav", ".mp3")
            gTTS(text=text, lang=lang or "en").save(mp3_path)
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", mp3_path,
                 "-ar", "8000", "-ac", "1", "-acodec", "pcm_u8", output_path],
                capture_output=True, timeout=30
            )
            if os.path.exists(mp3_path):
                try:
                    os.unlink(mp3_path)
                except OSError:
                    pass
            if result.returncode != 0:
                logger.error(f"SIP: ffmpeg failed converting gTTS audio: {result.stderr.decode()}")
                return False
            return True
        except Exception as e:
            logger.error(f"SIP: gTTS failed: {e}")
            return False

    @staticmethod
    def _tts_espeak(text: str, voice: str, speed: int | str, pitch: int | str, output_path: str) -> bool:
        try:
            rate_val = int(speed) if speed else 150
            pitch_val = int(pitch) if pitch else 50
            rate_arg = f"--rate={max(50, min(300, rate_val))}"
            pitch_arg = f"-p{max(0, min(99, pitch_val))}"
            voice_val = str(voice or "en").strip()
            result = subprocess.run(
                ["espeak", "-v", voice_val, "-w", output_path, rate_arg, pitch_arg, text],
                capture_output=True, timeout=30
            )
            if result.returncode != 0:
                logger.error(f"SIP: eSpeak failed: {result.stderr.decode()}")
                return False
            resampled = output_path.replace(".wav", "_8k.wav")
            result2 = subprocess.run(
                ["ffmpeg", "-y", "-i", output_path,
                 "-ar", "8000", "-ac", "1", "-acodec", "pcm_u8", resampled],
                capture_output=True, timeout=30
            )
            if result2.returncode == 0:
                os.replace(resampled, output_path)
            return True
        except FileNotFoundError:
            logger.error("SIP: eSpeak not found — install espeak or espeak-ng")
            return False
        except Exception as e:
            logger.error(f"SIP: eSpeak failed: {e}")
            return False

    @staticmethod
    def _translate_text_gemini(text: str, target_lang: str, api_key: str) -> str:
        """Translate alert text into target language using Gemini text generation if needed."""
        clean_lang = (target_lang or "en").lower().strip()
        if clean_lang == "en" or not clean_lang or not text or not api_key:
            return text

        lang_name = GEMINI_LANG_NAMES.get(clean_lang, clean_lang)
        prompt = (
            f"Translate the following vehicle telematics alert into {lang_name}. "
            "Return ONLY the direct translated sentence with natural pronunciation and no preamble, notes, or quotes:\n\n"
            f"{text.strip()}"
        )

        translation_models = [
            "gemini-flash-latest",
            "gemini-2.5-flash",
            "gemini-3.1-flash-lite-preview",
            "gemini-flash-lite-latest",
        ]

        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}]
        }

        with httpx.Client(timeout=15.0) as client:
            for m in translation_models:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={api_key}"
                try:
                    resp = client.post(url, json=payload)
                    if resp.status_code == 200:
                        data = resp.json()
                        candidates = data.get("candidates", [])
                        if candidates:
                            parts = candidates[0].get("content", {}).get("parts", [])
                            if parts and "text" in parts[0]:
                                translated = parts[0]["text"].strip()
                                if translated:
                                    logger.info(f"SIP: Translated alert to {lang_name}: '{translated}'")
                                    return translated
                except Exception as exc:
                    logger.debug(f"SIP: Gemini translation model '{m}' attempt failed: {exc}")

        logger.warning(f"SIP: Translation to {lang_name} failed; falling back to original text.")
        return text

    @staticmethod
    def _tts_gemini(
        text: str,
        api_key: str,
        model: str,
        voice: str,
        lang: str,
        output_path: str,
    ) -> bool:
        try:
            if not api_key:
                logger.error("SIP: Gemini TTS failed — no Gemini API key provided in system settings")
                return False

            # Translate text if target language is not English
            speak_text = SipChannel._translate_text_gemini(text, lang, api_key)

            clean_m = (model or "gemini-2.5-flash-preview-tts").replace("models/", "").strip()
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{clean_m}:generateContent?key={api_key}"

            def _build_payload(with_system_instruction: bool) -> dict:
                p = {
                    "contents": [{
                        "role": "user",
                        "parts": [{"text": speak_text}]
                    }],
                    "generationConfig": {
                        "responseModalities": ["AUDIO"],
                        "speechConfig": {
                            "voiceConfig": {
                                "prebuiltVoiceConfig": {
                                    "voiceName": (voice or "Aoede").strip()
                                }
                            }
                        }
                    }
                }
                if with_system_instruction and DEFAULT_GEMINI_DISPATCHER_INSTRUCTION:
                    p["systemInstruction"] = {
                        "parts": [{"text": DEFAULT_GEMINI_DISPATCHER_INSTRUCTION}]
                    }
                return p

            # Pure Gemini TTS models reject systemInstruction with 500 error; general multimodal models accept it
            is_pure_tts = "tts" in clean_m.lower()
            payload = _build_payload(with_system_instruction=not is_pure_tts)

            data = None
            with httpx.Client(timeout=35.0) as client:
                resp = client.post(url, json=payload)
                if resp.status_code == 200:
                    data = resp.json()
                elif resp.status_code == 500 and not is_pure_tts:
                    # Retry without systemInstruction if 500 returned
                    payload_no_inst = _build_payload(with_system_instruction=False)
                    resp_retry = client.post(url, json=payload_no_inst)
                    if resp_retry.status_code == 200:
                        data = resp_retry.json()
                    else:
                        resp = resp_retry

                if not data:
                    logger.warning(f"SIP: Gemini model '{clean_m}' error ({resp.status_code}): {resp.text}")
                    # Try fallback models
                    for fallback in ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-pro-preview-tts"]:
                        if fallback != clean_m:
                            fallback_url = f"https://generativelanguage.googleapis.com/v1beta/models/{fallback}:generateContent?key={api_key}"
                            fb_payload = _build_payload(with_system_instruction="tts" not in fallback.lower())
                            fb_resp = client.post(fallback_url, json=fb_payload)
                            if fb_resp.status_code == 200:
                                data = fb_resp.json()
                                break
                    if not data:
                        logger.error(f"SIP: Gemini TTS failed: {resp.text}")
                        return False
                else:
                    data = resp.json()

            candidates = data.get("candidates", [])
            if not candidates:
                logger.error("SIP: Gemini TTS returned no candidates")
                return False

            parts = candidates[0].get("content", {}).get("parts", [])
            inline_data = None
            for p in parts:
                if isinstance(p, dict) and "inlineData" in p:
                    inline_data = p["inlineData"]
                    break

            if not inline_data or "data" not in inline_data:
                logger.error("SIP: Gemini response did not contain audio inlineData")
                return False

            b64_data = inline_data["data"]
            mime_type = str(inline_data.get("mimeType", "")).lower()
            raw_audio = base64.b64decode(b64_data)

            with tempfile.NamedTemporaryFile(suffix=".tmp", delete=False) as raw_f:
                raw_path = raw_f.name
                raw_f.write(raw_audio)

            try:
                if "pcm" in mime_type or "rate=24000" in mime_type:
                    cmd = [
                        "ffmpeg", "-y",
                        "-f", "s16le",
                        "-ar", "24000",
                        "-ac", "1",
                        "-i", raw_path,
                        "-ar", "8000",
                        "-ac", "1",
                        "-acodec", "pcm_u8",
                        output_path,
                    ]
                else:
                    cmd = [
                        "ffmpeg", "-y",
                        "-i", raw_path,
                        "-ar", "8000",
                        "-ac", "1",
                        "-acodec", "pcm_u8",
                        output_path,
                    ]

                result = subprocess.run(cmd, capture_output=True, timeout=30)
                if result.returncode != 0:
                    logger.error(f"SIP: ffmpeg conversion of Gemini audio failed: {result.stderr.decode()}")
                    return False
                return True
            finally:
                if os.path.exists(raw_path):
                    try:
                        os.unlink(raw_path)
                    except OSError:
                        pass

        except Exception as e:
            logger.error(f"SIP: Gemini TTS failed: {e}", exc_info=True)
            return False

    # ── SIP call ──────────────────────────────────────────────────

    @staticmethod
    def _read_wav_frames(path: str) -> tuple[bytes, int, int]:
        with wave.open(path, "rb") as wf:
            return wf.readframes(wf.getnframes()), wf.getframerate(), wf.getsampwidth()

    @staticmethod
    def _call(params: dict, audio_path: str) -> bool:
        phone = None
        call  = None
        try:
            pcm_frames, _, _ = SipChannel._read_wav_frames(audio_path)

            phone = VoIPPhone(
                server=params["server"],
                port=params["port"],
                username=params["username"],
                password=params["password"],
                myIP="0.0.0.0",
                sipPort=0,
                rtpPortLow=10000,
                rtpPortHigh=20000,
            )
            phone.start()

            deadline = time.time() + 10
            while not phone.NSD and time.time() < deadline:
                time.sleep(0.2)
            if not phone.NSD:
                logger.warning("SIP: registration timed out — attempting call anyway")

            call = phone.call(params["extension"])

            deadline = time.time() + 30
            while time.time() < deadline:
                if call.state == CallState.ANSWERED:
                    break
                if call.state == CallState.ENDED:
                    logger.warning("SIP: call ended before being answered")
                    phone.stop()
                    return False
                time.sleep(0.1)
            else:
                logger.warning("SIP: timed out waiting for answer")
                try:
                    call.hangup()
                except InvalidStateError:
                    pass
                phone.stop()
                return False

            repeat        = max(1, params.get("repeat", 1))
            pause         = max(0, params.get("pause",  2))
            audio_seconds = len(pcm_frames) / 8000

            for i in range(repeat):
                if call.state != CallState.ANSWERED:
                    break
                try:
                    call.write_audio(pcm_frames)
                except InvalidStateError:
                    break

                stop = time.time() + audio_seconds
                while time.time() <= stop and call.state == CallState.ANSWERED:
                    time.sleep(0.1)

                if i < repeat - 1 and call.state == CallState.ANSWERED:
                    stop = time.time() + pause
                    while time.time() <= stop and call.state == CallState.ANSWERED:
                        time.sleep(0.1)

            try:
                if call.state == CallState.ANSWERED:
                    call.hangup()
            except InvalidStateError:
                pass

            time.sleep(0.5)
            phone.stop()
            logger.info(f"SIP: call to {params['extension']}@{params['server']} completed")
            return True

        except Exception as e:
            logger.error(f"SIP: call failed: {e}", exc_info=True)
            try:
                if call and call.state == CallState.ANSWERED:
                    call.hangup()
            except Exception:
                pass
            try:
                if phone:
                    phone.stop()
            except Exception:
                pass
            return False
