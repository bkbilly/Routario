"""
1NCE IoT connectivity integration for Routario.
Documentation: https://help.1nce.com/dev-hub/
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple, Union

import httpx

from sim_integrations.base import BaseSimIntegration
from sim_integrations.exceptions import (
    SimAuthenticationError,
    SimProviderError,
)
from sim_integrations.models import (
    DataSession,
    DataSessionStats,
    RemoteSimCard,
    SimCardInfo,
    SimProviderField,
)
from sim_integrations.registry import SimProviderRegistry
from sim_integrations.utils import format_data_size, format_status, parse_date

logger = logging.getLogger(__name__)


@SimProviderRegistry.register("1nce")
class OnceIntegration(BaseSimIntegration):
    """
    1NCE IoT Flat Rate connectivity integration.
    Communicates with 1NCE Management API v1.
    """
    PROVIDER_ID = "1nce"
    DISPLAY_NAME = "1NCE"

    FIELDS = [
        SimProviderField(
            key="client_id",
            label="Client ID / API Username",
            field_type="text",
            required=True,
            placeholder="e.g. your_client_id",
            help_text="1NCE API Client ID or username from the 1NCE Customer Portal.",
        ),
        SimProviderField(
            key="client_secret",
            label="Client Secret / API Password",
            field_type="password",
            required=True,
            placeholder="••••••••••••",
            help_text="1NCE API Client Secret or password.",
        ),
    ]

    BASE_URL = "https://api.1nce.com/management-api"
    OAUTH_URL = f"{BASE_URL}/oauth/token"
    SIMS_URL = f"{BASE_URL}/v1/sims"

    DEFAULT_HEADERS = {
        "Accept": "application/json",
        "User-Agent": "Routario-SIM-Integration/1.0",
    }

    async def _get_auth_token(
        self,
        client: httpx.AsyncClient,
        client_id: str,
        client_secret: str,
    ) -> str:
        """Obtain OAuth2 Bearer access token using Basic Auth credentials."""
        if not client_id or not client_secret:
            raise SimAuthenticationError("1NCE Client ID and Client Secret are required")

        auth_tuple = (client_id.strip(), client_secret.strip())
        try:
            resp = await client.post(
                self.OAUTH_URL,
                auth=auth_tuple,
                data={"grant_type": "client_credentials"},
                headers=self.DEFAULT_HEADERS,
            )
        except httpx.HTTPError as err:
            raise SimProviderError(f"1NCE connection failed: {err}") from err

        if resp.status_code in (400, 401, 403):
            try:
                err_data = resp.json()
                msg = err_data.get("message") or err_data.get("error_description") or err_data.get("error") or resp.text
            except Exception:
                msg = resp.text
            raise SimAuthenticationError(f"1NCE authentication failed: {msg}")

        if resp.status_code != 200:
            raise SimProviderError(
                f"1NCE token request failed with status {resp.status_code}: {resp.text}"
            )

        try:
            data = resp.json()
        except Exception as err:
            raise SimProviderError(f"Invalid JSON in 1NCE token response: {err}") from err

        access_token = data.get("access_token")
        if not access_token:
            raise SimAuthenticationError("1NCE token response missing access_token")

        return access_token

    async def test_credentials(self, credentials: Dict[str, Any]) -> Tuple[bool, str]:
        """Validate 1NCE API credentials by requesting a token and querying the SIM endpoint."""
        client_id = (credentials.get("client_id") or "").strip()
        client_secret = (credentials.get("client_secret") or "").strip()

        if not client_id or not client_secret:
            return False, "Client ID and Client Secret are required"

        async with httpx.AsyncClient(timeout=15.0, headers=self.DEFAULT_HEADERS) as client:
            try:
                token = await self._get_auth_token(client, client_id, client_secret)
                resp = await client.get(
                    f"{self.SIMS_URL}?pageSize=1",
                    headers={"Authorization": f"Bearer {token}", **self.DEFAULT_HEADERS},
                )
                if resp.status_code in (401, 403):
                    return False, "1NCE authentication failed: token rejected."
                resp.raise_for_status()
                return True, "Successfully connected to 1NCE API"
            except SimAuthenticationError as err:
                return False, str(err)
            except Exception as err:
                return False, f"1NCE connection error: {err}"

    async def fetch_remote_sims(self, credentials: Dict[str, Any]) -> List[RemoteSimCard]:
        """Fetch all SIM cards registered under the 1NCE customer account."""
        client_id = (credentials.get("client_id") or "").strip()
        client_secret = (credentials.get("client_secret") or "").strip()

        async with httpx.AsyncClient(timeout=25.0, headers=self.DEFAULT_HEADERS) as client:
            token = await self._get_auth_token(client, client_id, client_secret)
            auth_headers = {"Authorization": f"Bearer {token}", **self.DEFAULT_HEADERS}

            try:
                resp = await client.get(f"{self.SIMS_URL}?pageSize=100", headers=auth_headers)
                resp.raise_for_status()
                items = resp.json()
            except httpx.HTTPError as err:
                raise SimProviderError(f"Failed to fetch 1NCE SIM cards: {err}") from err

            if not isinstance(items, list):
                if isinstance(items, dict) and "data" in items and isinstance(items["data"], list):
                    items = items["data"]
                else:
                    items = []

            remote_sims: List[RemoteSimCard] = []
            for item in items:
                iccid = item.get("iccid") or ""
                msisdn = item.get("msisdn") or iccid
                if not msisdn:
                    continue

                status_raw = item.get("status") or "Active"
                status_formatted = format_status(status_raw)
                quota_total = item.get("current_quota") or 500
                plan_name = f"IoT Flat {quota_total}MB"

                # Query detailed quota for balance and expiry
                expiry_iso = None
                remaining_volume = None
                try:
                    q_resp = await client.get(
                        f"{self.SIMS_URL}/{iccid}/quota/data",
                        headers=auth_headers,
                    )
                    if q_resp.status_code == 200:
                        q_data = q_resp.json()
                        remaining_volume = q_data.get("volume")
                        if remaining_volume is not None:
                            remaining_volume = round(float(remaining_volume), 2)
                        exp_str = q_data.get("expiry_date") or ""
                        if exp_str:
                            for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
                                try:
                                    expiry_iso = datetime.strptime(exp_str[:19], fmt[:19] if len(fmt) > 10 else fmt).date().isoformat()
                                    break
                                except ValueError:
                                    pass
                except Exception as err:
                    logger.debug("Could not fetch 1NCE quota for %s: %s", iccid, err)

                rem_bytes = int(remaining_volume * 1024 * 1024) if remaining_volume is not None else None
                remote_sims.append(
                    RemoteSimCard(
                        phone_number=msisdn,
                        plan_name=plan_name,
                        balance=remaining_volume,
                        remaining_data_mb=remaining_volume,
                        remaining_data_bytes=rem_bytes,
                        currency="MB",
                        expiry_date=expiry_iso,
                        status=status_formatted,
                    )
                )

            return remote_sims

    async def get_data_sessions(
        self,
        credentials: Dict[str, Any],
        date_from: Optional[Union[date, datetime, str]] = None,
        date_till: Optional[Union[date, datetime, str]] = None,
        msisdn: Optional[str] = None,
    ) -> DataSessionStats:
        """Query SIM status, quota consumption, and usage metrics across 1NCE cards."""
        client_id = (credentials.get("client_id") or "").strip()
        client_secret = (credentials.get("client_secret") or "").strip()

        async with httpx.AsyncClient(timeout=30.0, headers=self.DEFAULT_HEADERS) as client:
            token = await self._get_auth_token(client, client_id, client_secret)
            auth_headers = {"Authorization": f"Bearer {token}", **self.DEFAULT_HEADERS}

            try:
                resp = await client.get(f"{self.SIMS_URL}?pageSize=100", headers=auth_headers)
                resp.raise_for_status()
                items = resp.json()
            except httpx.HTTPError as err:
                raise SimProviderError(f"Failed to query 1NCE SIM list: {err}") from err

            if not isinstance(items, list):
                if isinstance(items, dict) and "data" in items and isinstance(items["data"], list):
                    items = items["data"]
                else:
                    items = []

            per_sim_stats: Dict[str, DataSessionStats] = {}
            overall_bytes = 0
            overall_price = 0.0

            for item in items:
                iccid = item.get("iccid") or ""
                sim_msisdn = item.get("msisdn") or iccid
                if not sim_msisdn:
                    continue

                # If specific MSISDN requested, filter
                if msisdn and sim_msisdn != msisdn and iccid != msisdn:
                    continue

                status_raw = item.get("status") or "Active"
                status_formatted = format_status(status_raw)
                quota_total = item.get("current_quota") or 500
                plan_name = f"IoT Flat {quota_total}MB"

                expiry_iso = None
                remaining_volume = None
                consumed_mb = 0.0
                consumed_bytes = 0

                try:
                    q_resp = await client.get(
                        f"{self.SIMS_URL}/{iccid}/quota/data",
                        headers=auth_headers,
                    )
                    if q_resp.status_code == 200:
                        q_data = q_resp.json()
                        tot_vol = float(q_data.get("total_volume") or quota_total)
                        rem_vol = q_data.get("volume")
                        if rem_vol is not None:
                            remaining_volume = round(float(rem_vol), 2)
                            consumed_mb = max(0.0, tot_vol - float(rem_vol))
                            consumed_bytes = int(consumed_mb * 1024 * 1024)

                        exp_str = q_data.get("expiry_date") or ""
                        if exp_str:
                            for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
                                try:
                                    expiry_iso = datetime.strptime(exp_str[:19], fmt[:19] if len(fmt) > 10 else fmt).date().isoformat()
                                    break
                                except ValueError:
                                    pass
                except Exception as err:
                    logger.debug("Could not fetch 1NCE quota for %s: %s", iccid, err)

                rem_bytes = int(remaining_volume * 1024 * 1024) if remaining_volume is not None else None
                sim_stat = DataSessionStats(
                    total_billsec=format_data_size(consumed_bytes),
                    total_billsec_bytes=consumed_bytes,
                    total_user_price=0.0,
                    currency="MB",
                    sessions_count=1 if consumed_bytes > 0 else 0,
                    status=status_formatted,
                    balance=remaining_volume,
                    remaining_data_mb=remaining_volume,
                    remaining_data_bytes=rem_bytes,
                    expiry_date=expiry_iso,
                    plan_name=plan_name,
                    sessions=[],
                )

                per_sim_stats[sim_msisdn] = sim_stat
                if iccid and iccid != sim_msisdn:
                    per_sim_stats[iccid] = sim_stat

                overall_bytes += consumed_bytes

            return DataSessionStats(
                total_billsec=format_data_size(overall_bytes),
                total_billsec_bytes=overall_bytes,
                total_user_price=0.0,
                currency="MB",
                sessions_count=len(per_sim_stats),
                status="Active",
                balance=None,
                sessions=[],
                sim_data_sessions=per_sim_stats,
            )
