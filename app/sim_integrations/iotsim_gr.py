"""
IoTSim.gr SIM provider integration for Routario.
Directly implements portal scraping and data session extraction for https://portal.iotsim.gr/.
"""
from __future__ import annotations

from datetime import date, datetime
import logging
import re
from typing import Any, Dict, List, Optional, Tuple, Union

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None

import httpx

from sim_integrations.base import BaseSimIntegration
from sim_integrations.exceptions import AuthenticationError, SimProviderError
from sim_integrations.models import (
    DataSession,
    DataSessionStats,
    RemoteSimCard,
    SimCardInfo,
    SimProviderField,
)
from sim_integrations.registry import SimProviderRegistry
from sim_integrations.utils import (
    format_data_size,
    parse_data_size_to_bytes,
    parse_date,
    parse_price,
)

logger = logging.getLogger(__name__)


@SimProviderRegistry.register("iotsim_gr")
class IoTSimGrIntegration(BaseSimIntegration):
    PROVIDER_ID = "iotsim_gr"
    DISPLAY_NAME = "IoTSim.gr"
    FIELDS = [
        SimProviderField(
            key="username",
            label="Username",
            field_type="text",
            required=True,
            placeholder="portal username / email",
        ),
        SimProviderField(
            key="password",
            label="Password",
            field_type="password",
            required=True,
            placeholder="portal password",
        ),
    ]

    BASE_URL = "https://portal.iotsim.gr"
    LOGIN_URL = "https://portal.iotsim.gr/ui/login"
    HOME_URL = "https://portal.iotsim.gr/ui/"
    DATA_SESSIONS_URL = "https://portal.iotsim.gr/ui/stats/data_sessions"

    DEFAULT_HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,el-GR;q=0.8,el;q=0.7",
    }

    async def _login(self, client: httpx.AsyncClient, username: str, password: str) -> bool:
        """Authenticate with the IoTSim.gr portal."""
        login_data = {
            "login[username]": username,
            "login[password]": password,
        }
        headers = {
            "Origin": "https://www.iotsim.gr",
            "Referer": "https://www.iotsim.gr/login",
            "Content-Type": "application/x-www-form-urlencoded",
        }
        try:
            response = await client.post(self.LOGIN_URL, data=login_data, headers=headers)
            response.raise_for_status()

            url_str = str(response.url)
            if "bad_login" in url_str or "/login" in url_str:
                raise AuthenticationError(f"Authentication failed for user {username}. Returned URL: {url_str}")
            return True
        except httpx.HTTPError as err:
            raise AuthenticationError(f"HTTP error during login: {err}") from err

    async def test_credentials(self, credentials: Dict[str, Any]) -> Tuple[bool, str]:
        """Test login against IoTSim.gr portal."""
        username = str(credentials.get("username") or "").strip()
        password = str(credentials.get("password") or "").strip()
        if not username or not password:
            return False, "Username and password are required"

        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0, headers=self.DEFAULT_HEADERS) as client:
            try:
                await self._login(client, username, password)
                return True, "Connection successful"
            except Exception as e:
                return False, str(e)

    async def fetch_remote_sims(self, credentials: Dict[str, Any]) -> List[RemoteSimCard]:
        """Fetch SIM cards displayed in the portal overview."""
        username = str(credentials.get("username") or "").strip()
        password = str(credentials.get("password") or "").strip()
        if not username or not password:
            raise SimProviderError("Username and password are required")

        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0, headers=self.DEFAULT_HEADERS) as client:
            await self._login(client, username, password)

            try:
                response = await client.get(self.HOME_URL)
                response.raise_for_status()
            except httpx.HTTPError as err:
                raise SimProviderError(f"Failed to fetch home page: {err}") from err

            cards = self.parse_sim_cards(response.text)
            results: List[RemoteSimCard] = []
            for s in cards:
                exp_str = s.expiry_date.isoformat() if s.expiry_date else None
                results.append(
                    RemoteSimCard(
                        phone_number=s.phone_number,
                        iccid=s.contract_id,
                        plan_name=s.plan_name,
                        balance=s.balance,
                        remaining_data_mb=s.remaining_data_mb,
                        remaining_data_bytes=s.remaining_data_bytes,
                        currency=s.currency or "EUR",
                        expiry_date=exp_str,
                        status=s.status or "Active",
                    )
                )
            return results

    @classmethod
    def parse_sim_cards(cls, html: str) -> List[SimCardInfo]:
        """Parse SIM card cards from the overview HTML."""
        if BeautifulSoup is not None:
            soup = BeautifulSoup(html, "html.parser")
            sim_cards = []
            card_elements = soup.find_all(
                class_=lambda c: c and any(
                    cls == "sim-card" or (cls.startswith("sim-card") and "__" not in cls)
                    for cls in (c if isinstance(c, list) else c.split())
                )
            )
            if not card_elements:
                card_elements = soup.find_all(
                    class_=lambda c: c and any(
                        cls in ("sim-card", "sim_card", "sim-item", "device-card")
                        for cls in (c if isinstance(c, list) else c.split())
                    )
                )

            for card in card_elements:
                msisdn_elem = card.find(class_=lambda c: c and any(k in c.lower() for k in ("sim-card__msisdn", "msisdn", "phone", "number")))
                phone = msisdn_elem.get_text(strip=True) if msisdn_elem else ""
                if not phone:
                    m = re.search(r"\b(3069\d{8}|69\d{8}|\+3069\d{8})\b", card.get_text())
                    if m:
                        phone = m.group(1)

                plan_name = None
                expiry_date = None
                auto_renew = None
                plan_elem = card.find(class_=lambda c: c and any(k in c.lower() for k in ("sim-card__plan", "plan")))
                if plan_elem:
                    b_plan = plan_elem.find("b")
                    if b_plan:
                        plan_name = b_plan.get_text(strip=True)

                    plan_text = plan_elem.get_text(separator=" ", strip=True)
                    date_match = re.search(r"(\d{2})/(\d{2})/(\d{4})", plan_text)
                    if date_match:
                        try:
                            expiry_date = date(
                                int(date_match.group(3)),
                                int(date_match.group(2)),
                                int(date_match.group(1)),
                            )
                        except ValueError:
                            pass

                    if "ανανεωθεί αυτόματα" in plan_text:
                        auto_renew = True

                contract_id = None
                balance = None
                remaining_data_mb = None
                remaining_data_bytes = None

                # 1. Check for usage-tile (e.g. <div class="usage-tile usage-tile--data"> with <div class="usage-tile__value">496 MB</div>)
                usage_tile = card.find(class_=lambda c: c and "usage-tile" in c and "data" in c)
                if not usage_tile:
                    for ut in card.find_all(class_=lambda c: c and "usage-tile" in c):
                        lbl = ut.find(class_=lambda c: c and "usage-tile__label" in c)
                        if lbl and any(w in lbl.get_text().strip().lower() for w in ("δεδομενα", "δεδομένα", "data")):
                            usage_tile = ut
                            break
                if not usage_tile and len(card_elements) == 1:
                    usage_tile = soup.find(class_=lambda c: c and "usage-tile" in c and "data" in c)

                if usage_tile:
                    val_elem = usage_tile.find(class_=lambda c: c and "usage-tile__value" in c)
                    if val_elem:
                        val_str = val_elem.get_text(strip=True)
                        rem_bytes = parse_data_size_to_bytes(val_str)
                        if rem_bytes > 0:
                            remaining_data_mb = round(rem_bytes / (1024 * 1024), 2)
                            remaining_data_bytes = rem_bytes

                # 2. Check meta element for contract and monetary balance
                meta_elem = card.find(class_=lambda c: c and any(k in c.lower() for k in ("sim-card__meta", "meta")))
                if meta_elem:
                    meta_text = meta_elem.get_text(separator=" ", strip=True)
                    contract_match = re.search(r"Συμβόλαιο\s+(\d+)", meta_text)
                    if contract_match:
                        contract_id = contract_match.group(1)

                    balance_elem = meta_elem.find(class_=lambda c: c and any(k in c.lower() for k in ("sim-card__balance", "balance")))
                    if balance_elem:
                        bal_str = balance_elem.get_text(strip=True)
                        if any(unit in bal_str.lower() for unit in ("mb", "gb", "kb")):
                            if remaining_data_mb is None:
                                rem_bytes = parse_data_size_to_bytes(bal_str)
                                if rem_bytes > 0:
                                    remaining_data_mb = round(rem_bytes / (1024 * 1024), 2)
                                    remaining_data_bytes = rem_bytes
                        else:
                            balance = parse_price(bal_str)

                sim_cards.append(
                    SimCardInfo(
                        phone_number=phone,
                        plan_name=plan_name,
                        expiry_date=expiry_date,
                        auto_renew=auto_renew,
                        contract_id=contract_id,
                        balance=balance,
                        remaining_data_mb=remaining_data_mb,
                        remaining_data_bytes=remaining_data_bytes,
                        currency="EUR",
                        status="Active",
                    )
                )

            # If no structured card containers matched, try extracting global page info
            if not sim_cards:
                phone_m = re.search(r"\b(3069\d{8}|69\d{8}|\+3069\d{8})\b", soup.get_text())
                phone = phone_m.group(1) if phone_m else ""
                usage_tile = soup.find(class_=lambda c: c and "usage-tile" in c and "data" in c)
                rem_mb = None
                rem_b = None
                if usage_tile:
                    val_elem = usage_tile.find(class_=lambda c: c and "usage-tile__value" in c)
                    if val_elem:
                        rem_b = parse_data_size_to_bytes(val_elem.get_text(strip=True))
                        if rem_b > 0:
                            rem_mb = round(rem_b / (1024 * 1024), 2)
                if phone or rem_mb is not None:
                    sim_cards.append(
                        SimCardInfo(
                            phone_number=phone,
                            plan_name=None,
                            expiry_date=None,
                            auto_renew=False,
                            contract_id=None,
                            balance=None,
                            remaining_data_mb=rem_mb,
                            remaining_data_bytes=rem_b,
                            currency="EUR",
                            status="Active",
                        )
                    )
            return sim_cards

        # Fallback pure-Python regex parser
        sim_cards = []
        cards_raw = re.findall(r'<div[^>]+class=["\'][^"\']*\bsim-card(?![a-zA-Z0-9_-])(?:\s+[^"\']*)?["\'][^>]*>(.*?)(?=<div[^>]+class=["\'][^"\']*\bsim-card(?![a-zA-Z0-9_-])|\Z)', html, re.DOTALL)
        for card_html in cards_raw:
            phone_m = re.search(r'class=["\'][^"\']*sim-card__msisdn[^"\']*["\'][^>]*>([^<]+)<', card_html)
            phone = phone_m.group(1).strip() if phone_m else ""
            plan_name_m = re.search(r'class=["\'][^"\']*sim-card__plan[^"\']*["\'][^>]*>.*?<b>([^<]+)</b>', card_html, re.DOTALL)
            plan_name = plan_name_m.group(1).strip() if plan_name_m else None
            date_m = re.search(r'(\d{2})/(\d{2})/(\d{4})', card_html)
            expiry_date = None
            if date_m:
                try:
                    expiry_date = date(int(date_m.group(3)), int(date_m.group(2)), int(date_m.group(1)))
                except ValueError:
                    pass
            contract_m = re.search(r'Συμβόλαιο\s+(\d+)', card_html)
            contract_id = contract_m.group(1) if contract_m else None

            balance = None
            remaining_data_mb = None
            remaining_data_bytes = None

            # Check usage-tile
            usage_tile_m = re.search(
                r'class=["\'][^"\']*usage-tile(?:--data|\s+[^"\']*data)[^"\']*["\'][^>]*>.*?class=["\'][^"\']*usage-tile__value[^"\']*["\'][^>]*>([^<]+)<',
                card_html,
                re.DOTALL | re.IGNORECASE,
            )
            if not usage_tile_m:
                usage_tile_m = re.search(
                    r'(?:usage-tile__label[^>]*>\s*(?:ΔΕΔΟΜΕΝΑ|ΔΕΔΟΜΈΝΑ|DATA)\s*<.*?usage-tile__value[^>]*>([^<]+)<)',
                    card_html,
                    re.DOTALL | re.IGNORECASE,
                )
            if usage_tile_m:
                rem_bytes = parse_data_size_to_bytes(usage_tile_m.group(1).strip())
                remaining_data_mb = round(rem_bytes / (1024 * 1024), 2)
                remaining_data_bytes = rem_bytes

            balance_m = re.search(r'class=["\'][^"\']*sim-card__balance[^"\']*["\'][^>]*>([^<]+)<', card_html)
            if balance_m:
                bal_raw = balance_m.group(1).strip()
                if any(unit in bal_raw.lower() for unit in ("mb", "gb", "kb")):
                    if remaining_data_mb is None:
                        rem_bytes = parse_data_size_to_bytes(bal_raw)
                        remaining_data_mb = round(rem_bytes / (1024 * 1024), 2)
                        remaining_data_bytes = rem_bytes
                else:
                    balance = parse_price(bal_raw)

            sim_cards.append(
                SimCardInfo(
                    phone_number=phone,
                    plan_name=plan_name,
                    expiry_date=expiry_date,
                    auto_renew="ανανεωθεί αυτόματα" in card_html,
                    contract_id=contract_id,
                    balance=balance,
                    remaining_data_mb=remaining_data_mb,
                    remaining_data_bytes=remaining_data_bytes,
                    currency="EUR",
                    status="Active",
                )
            )
        return sim_cards

    async def _fetch_authenticity_token(self, client: httpx.AsyncClient) -> str:
        """Fetch the authenticity_token required for form POSTs."""
        try:
            resp = await client.get(self.DATA_SESSIONS_URL)
            resp.raise_for_status()
            if BeautifulSoup is not None:
                soup = BeautifulSoup(resp.text, "html.parser")
                token_input = soup.find("input", {"name": "authenticity_token"})
                if token_input and token_input.get("value"):
                    return str(token_input["value"])

            token_match = re.search(r'name=["\']authenticity_token["\']\s+value=["\']([^"\']+)["\']', resp.text)
            if not token_match:
                token_match = re.search(r'value=["\']([^"\']+)["\']\s+name=["\']authenticity_token["\']', resp.text)
            if token_match:
                return token_match.group(1)

            raise SimProviderError("Could not find authenticity_token in stats page")
        except httpx.HTTPError as err:
            raise SimProviderError(f"Failed to fetch data sessions page: {err}") from err

    async def get_data_sessions(
        self,
        credentials: Dict[str, Any],
        date_from: Optional[Union[date, datetime, str]] = None,
        date_till: Optional[Union[date, datetime, str]] = None,
        msisdn: Optional[str] = None,
    ) -> DataSessionStats:
        """Query data sessions stats over a date range."""
        username = str(credentials.get("username") or "").strip()
        password = str(credentials.get("password") or "").strip()
        if not username or not password:
            raise SimProviderError("Username and password are required")

        today = date.today()
        d_from = parse_date(date_from) if date_from is not None else date(today.year, today.month, 1)
        d_till = parse_date(date_till) if date_till is not None else today

        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0, headers=self.DEFAULT_HEADERS) as client:
            await self._login(client, username, password)

            # Discover current phone number and latest balance/expiry/plan/remaining_data
            current_phone = msisdn
            latest_balance = None
            latest_expiry = None
            latest_plan = None
            latest_remaining_mb = None
            latest_remaining_bytes = None
            sim_balances = {}
            sim_expiries = {}
            sim_plans = {}
            sim_rem_mb = {}
            sim_rem_bytes = {}
            try:
                home_resp = await client.get(self.HOME_URL)
                home_cards = self.parse_sim_cards(home_resp.text)
                norm_curr = re.sub(r"\D", "", str(current_phone)).lstrip("0") if current_phone else ""
                for c in home_cards:
                    norm_c = re.sub(r"\D", "", str(c.phone_number)).lstrip("0")
                    if c.balance is not None:
                        sim_balances[c.phone_number] = c.balance
                        if norm_c:
                            sim_balances[norm_c] = c.balance
                    if c.remaining_data_mb is not None:
                        sim_rem_mb[c.phone_number] = c.remaining_data_mb
                        sim_rem_bytes[c.phone_number] = c.remaining_data_bytes
                        if norm_c:
                            sim_rem_mb[norm_c] = c.remaining_data_mb
                            sim_rem_bytes[norm_c] = c.remaining_data_bytes
                    if c.expiry_date:
                        sim_expiries[c.phone_number] = c.expiry_date.isoformat()
                        if norm_c:
                            sim_expiries[norm_c] = c.expiry_date.isoformat()
                    if c.plan_name:
                        sim_plans[c.phone_number] = c.plan_name
                        if norm_c:
                            sim_plans[norm_c] = c.plan_name

                if home_cards and not current_phone:
                    current_phone = home_cards[0].phone_number
                    norm_curr = re.sub(r"\D", "", str(current_phone)).lstrip("0")

                if current_phone:
                    latest_balance = sim_balances.get(current_phone) or (sim_balances.get(norm_curr) if norm_curr else None)
                    latest_remaining_mb = sim_rem_mb.get(current_phone) or (sim_rem_mb.get(norm_curr) if norm_curr else None)
                    latest_remaining_bytes = sim_rem_bytes.get(current_phone) or (sim_rem_bytes.get(norm_curr) if norm_curr else None)
                    latest_expiry = sim_expiries.get(current_phone) or (sim_expiries.get(norm_curr) if norm_curr else None)
                    latest_plan = sim_plans.get(current_phone) or (sim_plans.get(norm_curr) if norm_curr else None)
                elif home_cards:
                    latest_balance = home_cards[0].balance
                    latest_remaining_mb = home_cards[0].remaining_data_mb
                    latest_remaining_bytes = home_cards[0].remaining_data_bytes
                    latest_expiry = home_cards[0].expiry_date.isoformat() if home_cards[0].expiry_date else None
                    latest_plan = home_cards[0].plan_name
            except Exception as e:
                logger.warning("Could not fetch overview cards: %s", e)

            token = await self._fetch_authenticity_token(client)
            post_data = {
                "utf8": "✓",
                "authenticity_token": token,
                "search_on": "1",
                "page": "1",
                "date_from[day]": str(d_from.day),
                "date_from[month]": str(d_from.month),
                "date_from[year]": str(d_from.year),
                "date_till[day]": str(d_till.day),
                "date_till[month]": str(d_till.month),
                "date_till[year]": str(d_till.year),
                "commit": "Αναζήτηση",
            }

            try:
                resp = await client.post(
                    self.DATA_SESSIONS_URL,
                    data=post_data,
                    headers={
                        "Origin": self.BASE_URL,
                        "Referer": self.DATA_SESSIONS_URL,
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                )
                resp.raise_for_status()
            except httpx.HTTPError as err:
                raise SimProviderError(f"Failed to query data sessions: {err}") from err

            stats = self.parse_data_sessions(resp.text)
            if stats.remaining_data_mb is not None:
                latest_remaining_mb = stats.remaining_data_mb
                latest_remaining_bytes = stats.remaining_data_bytes

            stats.balance = latest_balance
            stats.remaining_data_mb = latest_remaining_mb
            stats.remaining_data_bytes = latest_remaining_bytes
            stats.expiry_date = latest_expiry
            stats.plan_name = latest_plan
            stats.currency = "EUR"

            # Extract further pages if any
            total_pages = self._extract_total_pages(resp.text)
            for page_num in range(2, total_pages + 1):
                page_post = dict(post_data)
                page_post["page"] = str(page_num)
                try:
                    p_resp = await client.post(
                        self.DATA_SESSIONS_URL,
                        data=page_post,
                        headers={
                            "Origin": self.BASE_URL,
                            "Referer": self.DATA_SESSIONS_URL,
                            "Content-Type": "application/x-www-form-urlencoded",
                        },
                    )
                    p_resp.raise_for_status()
                    p_stats = self.parse_data_sessions(p_resp.text)
                    stats.sessions.extend(p_stats.sessions)
                except httpx.HTTPError as err:
                    logger.warning("Failed to fetch page %d: %s", page_num, err)
                    break

            if home_cards:
                sim_map = {}
                norm_curr = re.sub(r"\D", "", str(current_phone)).lstrip("0") if current_phone else ""
                for c in home_cards:
                    norm_c = re.sub(r"\D", "", str(c.phone_number)).lstrip("0")
                    is_match = (c.phone_number == current_phone) or (bool(norm_curr) and norm_c == norm_curr)
                    if is_match:
                        stats.remaining_data_mb = c.remaining_data_mb if c.remaining_data_mb is not None else stats.remaining_data_mb
                        stats.remaining_data_bytes = c.remaining_data_bytes if c.remaining_data_bytes is not None else stats.remaining_data_bytes
                        if c.balance is not None:
                            stats.balance = c.balance
                        if c.plan_name:
                            stats.plan_name = c.plan_name
                        if c.expiry_date:
                            stats.expiry_date = c.expiry_date.isoformat()
                        c_stat = stats
                    else:
                        c_stat = DataSessionStats(
                            total_billsec="0 Bytes",
                            total_billsec_bytes=0,
                            total_user_price=0.0,
                            currency="EUR",
                            sessions_count=0,
                            status=c.status,
                            balance=c.balance,
                            remaining_data_mb=c.remaining_data_mb,
                            remaining_data_bytes=c.remaining_data_bytes,
                            expiry_date=c.expiry_date.isoformat() if c.expiry_date else None,
                            plan_name=c.plan_name,
                            sessions=[],
                        )
                    sim_map[c.phone_number] = c_stat
                    if norm_c:
                        sim_map[norm_c] = c_stat
                        sim_map[f"+30{norm_c}"] = c_stat
                stats.sim_data_sessions = sim_map
            elif current_phone:
                norm_curr = re.sub(r"\D", "", str(current_phone)).lstrip("0")
                stats.sim_data_sessions = {
                    current_phone: stats,
                    norm_curr: stats,
                    f"+30{norm_curr}": stats,
                }

            return stats

    @classmethod
    def _extract_total_pages(cls, html: str) -> int:
        """Extract maximum page number from pagination."""
        if BeautifulSoup is not None:
            soup = BeautifulSoup(html, "html.parser")
            pag = soup.find(class_="pagination")
            if pag:
                pages = []
                for a in pag.find_all(["a", "span", "li"]):
                    text = a.get_text(strip=True)
                    if text.isdigit():
                        pages.append(int(text))
                if pages:
                    return max(pages)

        # Fallback regex
        pag_match = re.search(r'<[^>]+class=["\'][^"\']*pagination[^"\']*["\'][^>]*>(.*?)</(?:div|ul|nav)>', html, re.DOTALL)
        if pag_match:
            digits = re.findall(r'>(\d+)<', pag_match.group(1))
            if digits:
                return max(int(d) for d in digits)
        return 1

    @classmethod
    def parse_data_sessions(cls, html: str) -> DataSessionStats:
        """Parse total_billsec, total_user_price, remaining data, and session rows from response HTML."""
        total_billsec = "0.00 KB"
        total_user_price = 0.0
        remaining_data_mb = None
        remaining_data_bytes = None
        sessions = []

        if BeautifulSoup is not None:
            soup = BeautifulSoup(html, "html.parser")

            # 1. Total billsec (total consumption)
            billsec_elem = soup.find(id="total_billsec")
            total_billsec = billsec_elem.get_text(strip=True) if billsec_elem else "0.00 KB"

            # 2. Total user price
            price_elem = soup.find(id="total_user_price")
            price_raw = price_elem.get_text(strip=True) if price_elem else "0.0000 €"
            total_user_price = parse_price(price_raw)

            # 3. Check for usage-tile on data sessions page
            usage_tile = soup.find(class_=lambda c: c and "usage-tile" in c and "data" in c)
            if not usage_tile:
                for ut in soup.find_all(class_=lambda c: c and "usage-tile" in c):
                    lbl = ut.find(class_=lambda c: c and "usage-tile__label" in c)
                    if lbl and any(w in lbl.get_text().strip().lower() for w in ("δεδομενα", "δεδομένα", "data")):
                        usage_tile = ut
                        break
            if usage_tile:
                val_elem = usage_tile.find(class_=lambda c: c and "usage-tile__value" in c)
                if val_elem:
                    b_val = parse_data_size_to_bytes(val_elem.get_text(strip=True))
                    if b_val > 0:
                        remaining_data_bytes = b_val
                        remaining_data_mb = round(b_val / (1024 * 1024), 2)

            # 4. Session rows
            table = soup.find("table", class_="stats-table")
            if table and table.find("tbody"):
                for tr in table.find("tbody").find_all("tr"):
                    cols = tr.find_all("td")
                    if len(cols) < 7:
                        continue

                    date_val = None
                    date_text = cols[0].get_text(strip=True)
                    if date_text:
                        try:
                            date_val = datetime.strptime(date_text, "%d-%m-%Y %H:%M:%S")
                        except ValueError:
                            pass

                    status_val = cols[1].get_text(strip=True)

                    comp_val = None
                    comp_text = cols[2].get_text(strip=True)
                    if comp_text:
                        try:
                            comp_val = datetime.strptime(comp_text, "%d-%m-%Y %H:%M:%S")
                        except ValueError:
                            pass

                    country_val = cols[3].get_text(strip=True)
                    network_val = cols[4].get_text(strip=True)
                    billed_raw = cols[5].get_text(strip=True)
                    billed_bytes = parse_data_size_to_bytes(billed_raw)
                    row_price = parse_price(cols[6].get_text(strip=True))

                    sessions.append(
                        DataSession(
                            date=date_val,
                            status=status_val,
                            completed_at=comp_val,
                            country=country_val,
                            network=network_val,
                            billed_raw=billed_raw,
                            billed_bytes=billed_bytes,
                            price=row_price,
                            currency="EUR",
                        )
                    )
        else:
            billsec_m = re.search(r'id=["\']total_billsec["\'][^>]*>([^<]+)<', html)
            if billsec_m:
                total_billsec = billsec_m.group(1).strip()
            price_m = re.search(r'id=["\']total_user_price["\'][^>]*>([^<]+)<', html)
            if price_m:
                total_user_price = parse_price(price_m.group(1))

            usage_tile_m = re.search(
                r'class=["\'][^"\']*usage-tile(?:--data|\s+[^"\']*data)[^"\']*["\'][^>]*>.*?class=["\'][^"\']*usage-tile__value[^"\']*["\'][^>]*>([^<]+)<',
                html,
                re.DOTALL | re.IGNORECASE,
            )
            if not usage_tile_m:
                usage_tile_m = re.search(
                    r'(?:usage-tile__label[^>]*>\s*(?:ΔΕΔΟΜΕΝΑ|ΔΕΔΟΜΈΝΑ|DATA)\s*<.*?usage-tile__value[^>]*>([^<]+)<)',
                    html,
                    re.DOTALL | re.IGNORECASE,
                )
            if usage_tile_m:
                b_val = parse_data_size_to_bytes(usage_tile_m.group(1).strip())
                if b_val > 0:
                    remaining_data_bytes = b_val
                    remaining_data_mb = round(b_val / (1024 * 1024), 2)

        total_billsec_bytes = parse_data_size_to_bytes(total_billsec)
        return DataSessionStats(
            total_billsec=total_billsec,
            total_billsec_bytes=total_billsec_bytes,
            total_user_price=total_user_price,
            remaining_data_mb=remaining_data_mb,
            remaining_data_bytes=remaining_data_bytes,
            currency="EUR",
            sessions_count=len(sessions),
            status="Active",
            sessions=sessions,
        )
