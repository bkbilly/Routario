"""
Things Mobile SIM provider integration for Routario.
Directly implements Business API calls, SIM list, credit check, and CDR parsing for https://api.thingsmobile.com/.
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime
import logging
import re
from typing import Any, Dict, List, Optional, Tuple, Union
import xml.etree.ElementTree as ET

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
    format_status,
    parse_data_size_to_bytes,
    parse_date,
    parse_price,
)

logger = logging.getLogger(__name__)


@SimProviderRegistry.register("thingsmobile")
class ThingsMobileIntegration(BaseSimIntegration):
    PROVIDER_ID = "thingsmobile"
    DISPLAY_NAME = "Things Mobile"
    FIELDS = [
        SimProviderField(
            key="username",
            label="Account Username / Email",
            field_type="text",
            required=True,
            placeholder="e.g. user@example.com",
            help_text="The email/username used to sign in to the Things Mobile portal.",
        ),
        SimProviderField(
            key="token",
            label="API Token",
            field_type="password",
            required=True,
            placeholder="API token from Things Mobile portal",
            help_text="Generated in Things Mobile portal > API > API Tokens.",
        ),
    ]

    BASE_URL = "https://api.thingsmobile.com/services/business-api/"
    SIM_LIST_URL = BASE_URL + "simListLite"
    SIM_STATUS_URL = BASE_URL + "simStatus"
    CREDIT_URL = BASE_URL + "credit"

    DEFAULT_HEADERS = {
        "User-Agent": "Routario/1.0",
        "Accept": "application/xml, text/xml, */*",
    }

    async def _post_api(
        self,
        client: httpx.AsyncClient,
        endpoint: str,
        username: str,
        token: str,
        extra_data: Optional[dict] = None,
    ) -> ET.Element:
        """Perform a POST request with automatic retry for rate limits."""
        data = {
            "username": username,
            "token": token,
        }
        if extra_data:
            data.update(extra_data)

        max_retries = 3
        delay = 1.5

        for attempt in range(max_retries):
            try:
                response = await client.post(endpoint, data=data)
                response.raise_for_status()
                root = ET.fromstring(response.text)

                done_elem = root.find("done")
                if done_elem is not None and done_elem.text == "false":
                    error_code = root.findtext("errorCode", "")
                    error_msg = root.findtext("errorMessage") or root.findtext("message", "")

                    if error_code == "60" and attempt < max_retries - 1:
                        await asyncio.sleep(delay)
                        delay *= 2
                        continue

                    if error_code in ("20", "30") or "authentication failed" in error_msg.lower():
                        raise AuthenticationError(
                            f"Things Mobile authentication error: {error_msg} (code {error_code})"
                        )
                    raise SimProviderError(f"Things Mobile error: {error_msg} (code {error_code})")

                return root
            except httpx.HTTPError as err:
                if attempt < max_retries - 1:
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                raise SimProviderError(f"Things Mobile HTTP request failed: {err}") from err

        raise SimProviderError("Failed to query Things Mobile API after multiple attempts")

    async def test_credentials(self, credentials: Dict[str, Any]) -> Tuple[bool, str]:
        """Test credentials by querying account credit."""
        username = str(credentials.get("username") or "").strip()
        token = str(credentials.get("token") or "").strip()
        if not username or not token:
            return False, "Username and token are required"

        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0, headers=self.DEFAULT_HEADERS) as client:
            try:
                await self._post_api(client, self.CREDIT_URL, username, token)
                return True, "Connection successful"
            except Exception as e:
                return False, str(e)

    async def fetch_remote_sims(self, credentials: Dict[str, Any]) -> List[RemoteSimCard]:
        """Fetch all SIM cards registered under this account."""
        username = str(credentials.get("username") or "").strip()
        token = str(credentials.get("token") or "").strip()
        if not username or not token:
            raise SimProviderError("Username and token are required")

        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0, headers=self.DEFAULT_HEADERS) as client:
            credit_root = await self._post_api(client, self.CREDIT_URL, username, token)
            credit_text = (
                credit_root.findtext("amount")
                or credit_root.findtext("credit")
                or credit_root.findtext("balance")
            )
            default_balance = parse_price(credit_text) if credit_text else None
            currency = credit_root.findtext("currency") or "EUR"

            root = await self._post_api(client, self.SIM_LIST_URL, username, token)
            sims = self.parse_sim_list(root, default_balance=default_balance, currency=currency)

            results: List[RemoteSimCard] = []
            for s in sims:
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
                        status=s.status,
                    )
                )
            return results

    @classmethod
    def parse_sim_list(
        cls,
        root: ET.Element,
        default_balance: Optional[float] = None,
        currency: str = "EUR",
    ) -> List[SimCardInfo]:
        """Parse SIM list XML element tree."""
        sims = []
        for sim_node in root.findall(".//sims/sim"):
            msisdn = sim_node.findtext("msisdn", "")
            plan_name = sim_node.findtext("plan") or sim_node.findtext("priceListType")
            contract_id = sim_node.findtext("iccid") or sim_node.findtext("tag")

            expiry_date = None
            exp_text = sim_node.findtext("expirationDate", "")
            if exp_text:
                for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
                    try:
                        expiry_date = datetime.strptime(exp_text.strip(), fmt).date()
                        break
                    except ValueError:
                        pass

            # In Things Mobile, monetary balance is the shared account credit from /credit.
            # Pay-per-use SIMs do not have a fixed remaining data quota (billed per MB against monetary credit).
            balance = default_balance
            rem_data_mb = None
            rem_data_bytes = None

            status_raw = sim_node.findtext("status", "")
            status_formatted = format_status(status_raw)
            auto_renew = status_raw.lower() == "active"

            sims.append(
                SimCardInfo(
                    phone_number=msisdn,
                    plan_name=plan_name,
                    expiry_date=expiry_date,
                    auto_renew=auto_renew,
                    contract_id=contract_id,
                    balance=balance,
                    remaining_data_mb=rem_data_mb,
                    remaining_data_bytes=rem_data_bytes,
                    currency=currency,
                    status=status_formatted,
                )
            )

        return sims

    async def get_data_sessions(
        self,
        credentials: Dict[str, Any],
        date_from: Optional[Union[date, datetime, str]] = None,
        date_till: Optional[Union[date, datetime, str]] = None,
        msisdn: Optional[str] = None,
    ) -> DataSessionStats:
        """Fetch data session stats for SIM cards within the provided date range."""
        username = str(credentials.get("username") or "").strip()
        token = str(credentials.get("token") or "").strip()
        if not username or not token:
            raise SimProviderError("Username and token are required")

        today = date.today()
        d_from = parse_date(date_from) if date_from is not None else date(today.year, today.month, 1)
        d_till = parse_date(date_till) if date_till is not None else today

        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0, headers=self.DEFAULT_HEADERS) as client:
            latest_balance = None
            credit_currency = "EUR"
            try:
                credit_root = await self._post_api(client, self.CREDIT_URL, username, token)
                credit_text = (
                    credit_root.findtext("amount")
                    or credit_root.findtext("credit")
                    or credit_root.findtext("balance")
                )
                latest_balance = parse_price(credit_text) if credit_text else None
                credit_currency = credit_root.findtext("currency") or "EUR"
            except Exception as e:
                logger.warning("Could not fetch account credit: %s", e)

            if msisdn:
                root = await self._post_api(client, self.SIM_STATUS_URL, username, token, extra_data={"msisdn": msisdn})
                single_stats = self.parse_data_sessions(root, date_from=d_from, date_till=d_till)
                single_stats.balance = latest_balance
                single_stats.currency = credit_currency
                single_stats.sim_data_sessions = {msisdn: single_stats}
                return single_stats

            sim_list_root = await self._post_api(client, self.SIM_LIST_URL, username, token)
            sim_elements = sim_list_root.findall(".//sims/sim")

            per_sim_stats: dict[str, DataSessionStats] = {}
            all_sessions = []
            overall_bytes = 0
            overall_price = 0.0

            for sim_elem in sim_elements:
                sim_msisdn = sim_elem.findtext("msisdn", "")
                if not sim_msisdn:
                    continue

                sim_status_raw = sim_elem.findtext("status", "")
                sim_status_formatted = format_status(sim_status_raw)

                plan_name = sim_elem.findtext("plan") or sim_elem.findtext("priceListType")
                exp_text = sim_elem.findtext("expirationDate", "").strip()
                exp_iso = None
                if exp_text:
                    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
                        try:
                            exp_iso = datetime.strptime(exp_text, fmt).date().isoformat()
                            break
                        except ValueError:
                            pass

                total_traffic_str = sim_elem.findtext("totalTraffic") or "0"
                total_traffic = int(total_traffic_str) if total_traffic_str.isdigit() else 0

                raw_bal = sim_elem.findtext("balance")
                rem_data_mb = None
                rem_data_bytes = None

                if total_traffic == 0:
                    sim_stat = DataSessionStats(
                        total_billsec="0 Bytes",
                        total_billsec_bytes=0,
                        total_user_price=0.0,
                        currency=credit_currency,
                        sessions_count=0,
                        status=sim_status_formatted,
                        balance=latest_balance,
                        remaining_data_mb=rem_data_mb,
                        remaining_data_bytes=rem_data_bytes,
                        expiry_date=exp_iso,
                        plan_name=plan_name,
                        sessions=[],
                    )
                else:
                    try:
                        sim_status_root = await self._post_api(
                            client,
                            self.SIM_STATUS_URL,
                            username,
                            token,
                            extra_data={"msisdn": sim_msisdn},
                        )
                        sim_stat = self.parse_data_sessions(
                            sim_status_root,
                            date_from=d_from,
                            date_till=d_till,
                        )
                        sim_stat.status = sim_status_formatted
                        sim_stat.balance = latest_balance
                        sim_stat.remaining_data_mb = rem_data_mb
                        sim_stat.remaining_data_bytes = rem_data_bytes
                        sim_stat.expiry_date = exp_iso
                        sim_stat.plan_name = plan_name
                        sim_stat.currency = credit_currency
                    except SimProviderError as err:
                        logger.warning("Could not fetch CDRs for SIM %s: %s", sim_msisdn, err)
                        sim_stat = DataSessionStats(
                            total_billsec="0 Bytes",
                            total_billsec_bytes=0,
                            total_user_price=0.0,
                            currency=credit_currency,
                            sessions_count=0,
                            status=sim_status_formatted,
                            balance=latest_balance,
                            remaining_data_mb=rem_data_mb,
                            remaining_data_bytes=rem_data_bytes,
                            expiry_date=exp_iso,
                            plan_name=plan_name,
                            sessions=[],
                        )

                per_sim_stats[sim_msisdn] = sim_stat
                all_sessions.extend(sim_stat.sessions)
                overall_bytes += sim_stat.total_billsec_bytes
                overall_price += sim_stat.total_user_price

            return DataSessionStats(
                total_billsec=format_data_size(overall_bytes),
                total_billsec_bytes=overall_bytes,
                total_user_price=round(overall_price, 4),
                currency=credit_currency,
                sessions_count=len(all_sessions),
                status="Active",
                balance=latest_balance,
                sessions=all_sessions,
                sim_data_sessions=per_sim_stats,
            )

    @classmethod
    def parse_data_sessions(
        cls,
        root: ET.Element,
        date_from: Optional[date] = None,
        date_till: Optional[date] = None,
    ) -> DataSessionStats:
        """Filter CDR records by date range and calculate totals."""
        sessions = []
        total_bytes = 0
        total_price = 0.0
        currency = "EUR"

        cdrs = root.findall(".//sims/sim/cdrs/cdr")
        for cdr in cdrs:
            start_str = cdr.findtext("cdrDateStart", "")
            stop_str = cdr.findtext("cdrDateStop", "")

            date_val = None
            if start_str:
                for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
                    try:
                        date_val = datetime.strptime(start_str.strip(), fmt)
                        break
                    except ValueError:
                        pass

            comp_val = None
            if stop_str:
                for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
                    try:
                        comp_val = datetime.strptime(stop_str.strip(), fmt)
                        break
                    except ValueError:
                        pass

            if date_val:
                session_date = date_val.date()
                if date_from and session_date < date_from:
                    continue
                if date_till and session_date > date_till:
                    continue

            traffic_text = cdr.findtext("cdrTraffic", "0")
            billed_bytes = int(traffic_text) if traffic_text.isdigit() else parse_data_size_to_bytes(traffic_text)
            total_bytes += billed_bytes

            cost_text = cdr.findtext("cdrCostToCustomer", "0")
            price = parse_price(cost_text)
            total_price += price

            country = cdr.findtext("cdrCountry", "")
            network = cdr.findtext("cdrOperator") or cdr.findtext("cdrNetwork", "")

            sessions.append(
                DataSession(
                    date=date_val,
                    status="Completed",
                    completed_at=comp_val,
                    country=country,
                    network=network,
                    billed_raw=format_data_size(billed_bytes),
                    billed_bytes=billed_bytes,
                    price=price,
                    currency=currency,
                )
            )

        total_billsec = format_data_size(total_bytes)
        return DataSessionStats(
            total_billsec=total_billsec,
            total_billsec_bytes=total_bytes,
            total_user_price=round(total_price, 4),
            currency=currency,
            sessions_count=len(sessions),
            status="Active",
            sessions=sessions,
        )
