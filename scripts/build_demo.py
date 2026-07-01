#!/usr/bin/env python3
"""Build the static GitHub Pages demo from the production frontend files."""

from __future__ import annotations

import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SITE_DEMO = ROOT / "site" / "demo"


def patch_html(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = text.replace('href="/icons/', 'href="icons/')
    text = text.replace('src="/icons/', 'src="icons/')
    text = text.replace('src="/js/', 'src="js/')
    text = text.replace('href="/manifest.json"', 'href="manifest.json"')
    text = text.replace('src="/js/config.js"', 'src="js/config.js"')
    text = text.replace("window.location.href = '/gps-dashboard.html';", "window.location.href = 'gps-dashboard.html';")
    text = text.replace('window.location.href = "/gps-dashboard.html";', 'window.location.href = "gps-dashboard.html";')
    text = text.replace("window.location.href = 'login.html';", "window.location.href = 'login.html';")
    text = text.replace('window.location.href = "/login.html";', 'window.location.href = "login.html";')
    text = text.replace("`${location.origin}/sw.js`", "new URL('sw.js', location.href).href")
    text = text.replace('    <script src="js/pwa.js"></script>\n', '')
    text = text.replace('<script src="js/pwa.js"></script>\n', '')
    if 'src="js/config.js"' in text and 'src="js/demo-mock-api.js"' not in text:
        text = text.replace('src="js/config.js"', 'src="js/demo-mock-api.js"></script>\n<script src="js/config.js"', 1)
    path.write_text(text, encoding="utf-8")


def patch_config(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = text.replace("'/login.html'", "'login.html'")
    text = text.replace('"/login.html"', '"login.html"')
    text = text.replace("'/icons/icon-192.png'", "'icons/icon-192.png'")
    text = text.replace('"/icons/icon-192.png"', '"icons/icon-192.png"')
    text = text.replace("`/manifest.json?company_id=${cid}`", "`manifest.json?company_id=${cid}`")
    text = text.replace("`/manifest.json?company_id=${cid}&v=${version}`", "`manifest.json?company_id=${cid}&v=${version}`")
    path.write_text(text, encoding="utf-8")


def patch_demo_runtime_js() -> None:
    pwa = SITE_DEMO / "js" / "pwa.js"
    pwa_text = pwa.read_text(encoding="utf-8")
    if "window.ROUTARIO_DEMO" not in pwa_text:
        pwa.write_text(
            "if (window.ROUTARIO_DEMO) {\n"
            "  window.initPWA = async function initPWA() { return null; };\n"
            "  window.enablePushNotifications = async function enablePushNotifications() { return false; };\n"
            "} else {\n"
            f"{pwa_text}\n"
            "}\n",
            encoding="utf-8",
        )

    voice = SITE_DEMO / "js" / "voice-ptt.js"
    voice_text = voice.read_text(encoding="utf-8")
    voice_text = voice_text.replace("href: '/css/voice-ptt.css'", "href: 'css/voice-ptt.css'")
    voice.write_text(voice_text, encoding="utf-8")

    settings_nav = SITE_DEMO / "js" / "settings-nav.js"
    settings_text = settings_nav.read_text(encoding="utf-8")
    settings_text = settings_text.replace("`${location.origin}/sw.js`", "new URL('sw.js', location.href).href")
    settings_nav.write_text(settings_text, encoding="utf-8")


def main() -> None:
    if SITE_DEMO.exists():
        shutil.rmtree(SITE_DEMO)
    SITE_DEMO.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(WEB, SITE_DEMO, ignore=shutil.ignore_patterns("uploads"))
    (SITE_DEMO / "index.html").write_text(
        '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=login.html">'
        '<title>Routario Demo</title><a href="login.html">Open Routario Demo</a>\n',
        encoding="utf-8",
    )
    for html in SITE_DEMO.glob("*.html"):
        patch_html(html)
    patch_config(SITE_DEMO / "js" / "config.js")
    patch_demo_runtime_js()


if __name__ == "__main__":
    main()
