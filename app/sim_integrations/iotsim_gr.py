"""
IoTSim.gr SIM provider integration for Routario.
Directly implements portal scraping and data session extraction for https://portal.iotsim.gr/.
"""
from __future__ import annotations

from datetime import date, datetime
import logging
import re
from typing import Any, Dict, List, Optional, Tuple, Union

from bs4 import BeautifulSoup
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
                        currency=s.currency or "EUR",
                        expiry_date=exp_str,
                        status=s.status or "Active",
                    )
                )
            return results

    @classmethod
    def parse_sim_cards(cls, html: str) -> List[SimCardInfo]:
        """Parse SIM card cards from the overview HTML."""
        soup = BeautifulSoup(html, "html.parser")
        sim_cards = []

        card_elements = soup.find_all(class_="sim-card")
        for card in card_elements:
            msisdn_elem = card.find(class_="sim-card__msisdn")
            phone = msisdn_elem.get_text(strip=True) if msisdn_elem else ""

            plan_name = None
            expiry_date = None
            auto_renew = None
            plan_elem = card.find(class_="sim-card__plan")
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
            meta_elem = card.find(class_="sim-card__meta")
            if meta_elem:
                meta_text = meta_elem.get_text(separator=" ", strip=True)
                contract_match = re.search(r"Συμβόλαιο\s+(\d+)", meta_text)
                if contract_match:
                    contract_id = contract_match.group(1)

                balance_elem = meta_elem.find(class_="sim-card__balance")
                if balance_elem:
                    balance = parse_price(balance_elem.get_text(strip=True))

            sim_cards.append(
                SimCardInfo(
                    phone_number=phone,
                    plan_name=plan_name,
                    expiry_date=expiry_date,
                    auto_renew=auto_renew,
                    contract_id=contract_id,
                    balance=balance,
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
            soup = BeautifulSoup(resp.text, "html.parser")
            token_input = soup.find("input", {"name": "authenticity_token"})
            if not token_input or not token_input.get("value"):
                raise SimProviderError("Could not find authenticity_token in stats page")
            return str(token_input["value"])
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

            # Discover current phone number and latest balance/expiry/plan
            current_phone = msisdn
            latest_balance = None
            latest_expiry = None
            latest_plan = None
            sim_balances = {}
            sim_expiries = {}
            sim_plans = {}
            try:
                home_resp = await client.get(self.HOME_URL)
                home_cards = self.parse_sim_cards(home_resp.text)
                for c in home_cards:
                    if c.balance is not None:
                        sim_balances[c.phone_number] = c.balance
                    if c.expiry_date:
                        sim_expiries[c.phone_number] = c.expiry_date.isoformat()
                    if c.plan_name:
                        sim_plans[c.phone_number] = c.plan_name
                if home_cards and not current_phone:
                    current_phone = home_cards[0].phone_number
                if current_phone:
                    latest_balance = sim_balances.get(current_phone)
                    latest_expiry = sim_expiries.get(current_phone)
                    latest_plan = sim_plans.get(current_phone)
                elif home_cards:
                    latest_balance = home_cards[0].balance
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
            stats.balance = latest_balance
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
                for c in home_cards:
                    if c.phone_number == current_phone:
                        sim_map[c.phone_number] = stats
                    else:
                        sim_map[c.phone_number] = DataSessionStats(
                            total_billsec="0 Bytes",
                            total_billsec_bytes=0,
                            total_user_price=0.0,
                            currency="EUR",
                            sessions_count=0,
                            status=c.status,
                            balance=c.balance,
                            expiry_date=c.expiry_date.isoformat() if c.expiry_date else None,
                            plan_name=c.plan_name,
                            sessions=[],
                        )
                stats.sim_data_sessions = sim_map
            elif current_phone:
                stats.sim_data_sessions = {current_phone: stats}

            return stats

    @classmethod
    def _extract_total_pages(cls, html: str) -> int:
        """Extract maximum page number from pagination."""
        soup = BeautifulSoup(html, "html.parser")
        pag = soup.find(class_="pagination")
        if not pag:
            return 1

        pages = []
        for a in pag.find_all(["a", "span", "li"]):
            text = a.get_text(strip=True)
            if text.isdigit():
                pages.append(int(text))

        return max(pages) if pages else 1

    @classmethod
    def parse_data_sessions(cls, html: str) -> DataSessionStats:
        """Parse total_billsec, total_user_price, and session rows from response HTML."""
        soup = BeautifulSoup(html, "html.parser")

        # 1. Total billsec (total consumption)
        billsec_elem = soup.find(id="total_billsec")
        total_billsec = billsec_elem.get_text(strip=True) if billsec_elem else "0.00 KB"
        total_billsec_bytes = parse_data_size_to_bytes(total_billsec)

        # 2. Total user price
        price_elem = soup.find(id="total_user_price")
        price_raw = price_elem.get_text(strip=True) if price_elem else "0.0000 €"
        total_user_price = parse_price(price_raw)

        # 3. Session rows
        sessions = []
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

        return DataSessionStats(
            total_billsec=total_billsec,
            total_billsec_bytes=total_billsec_bytes,
            total_user_price=total_user_price,
            currency="EUR",
            sessions_count=len(sessions),
            status="Active",
            sessions=sessions,
        )
