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
import logging
import os
import subprocess
import tempfile
import time
import wave
from urllib.parse import urlparse, parse_qs

from gtts import gTTS
from pyVoIP.VoIP import VoIPPhone, CallState, InvalidStateError

from .base import BaseNotificationChannel

logger = logging.getLogger(__name__)


class SipChannel(BaseNotificationChannel):

    @classmethod
    def matches(cls, url: str) -> bool:
        return url.strip().lower().startswith("sip://")

    async def send(self, url: str, title: str, message: str) -> bool:
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
            tts_ok = await asyncio.get_event_loop().run_in_executor(
                None,
                self._generate_tts,
                message,
                params["tts"],
                params["lang"],
                audio_path,
            )
            if not tts_ok:
                logger.error("SIP: TTS generation failed")
                return False

            logger.info(
                f"SIP: calling {params['extension']}@{params['server']} "
                f"(repeat={params['repeat']}, tts={params['tts']}, lang={params['lang']})"
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
        try:
            parsed = urlparse(url)
            extension = parsed.path.lstrip("/")
            if not extension:
                logger.warning(f"SIP URL has no extension: {url}")
                return None

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
                "extension": extension,
                "repeat":    _int("repeat", 1),
                "pause":     _int("pause",  2),
                "tts":       _str("tts",    "gtts"),
                "lang":      _str("lang",   "en"),
                "file":      _str("file",   None),
            }
        except Exception as e:
            logger.error(f"SIP: failed to parse URL '{url}': {e}")
            return None

    # ── TTS ───────────────────────────────────────────────────────

    @staticmethod
    def _generate_tts(text: str, engine: str, lang: str, output_path: str) -> bool:
        if engine == "espeak":
            return SipChannel._tts_espeak(text, lang, output_path)
        return SipChannel._tts_gtts(text, lang, output_path)

    @staticmethod
    def _tts_gtts(text: str, lang: str, output_path: str) -> bool:
        try:
            mp3_path = output_path.replace(".wav", ".mp3")
            gTTS(text=text, lang=lang).save(mp3_path)
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", mp3_path,
                 "-ar", "8000", "-ac", "1", "-acodec", "pcm_u8", output_path],
                capture_output=True, timeout=30
            )
            os.unlink(mp3_path)
            if result.returncode != 0:
                logger.error(f"SIP: ffmpeg failed: {result.stderr.decode()}")
                return False
            return True
        except Exception as e:
            logger.error(f"SIP: gTTS failed: {e}")
            return False

    @staticmethod
    def _tts_espeak(text: str, lang: str, output_path: str) -> bool:
        try:
            result = subprocess.run(
                ["espeak", "-v", lang, "-w", output_path, "--rate=150", text],
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
            logger.error("SIP: eSpeak not found — install espeak")
            return False
        except Exception as e:
            logger.error(f"SIP: eSpeak failed: {e}")
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
