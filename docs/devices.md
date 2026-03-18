# Supported Devices

Routario includes built-in native decoders for the most popular GPS tracker protocols. Each decoder runs on its own TCP/UDP port and handles the full device lifecycle — login, position, heartbeat, and outbound commands.

!!! info "Cloud devices"
    Devices already connected to **Wialon** or **Flespi Cloud** can be pulled in via cloud integrations — no direct connection needed. See [Cloud Integrations](integrations.md).

---

## Protocol Reference

| Protocol | Port | Transport | Compatible Devices |
|---|---|---|---|
| **Teltonika** | `5027` | TCP + UDP | FMB001, FMB010, FMB020, FMB110, FMB120, FMB125, FMB130, FMB140, FMB204, FMB641, FMB920, FMB930, FMC, TAT, TFT series — any Codec 8 / 8E / 16 / 26 device |
| **GT06 / Concox** | `5023` | TCP | GT06, GT06N, GT06E, Concox GK309, JimiIoT JM-VG01U, and compatible `0x78 0x78` binary frame clones |
| **TK103 / Coban** | `5001` | TCP | Coban TK103, TK103A, TK103B, Xexun XT009, and compatible ASCII-framed clones |
| **GPS103** | `5002` | TCP | GPS103, GPS103-B, Coban GPS103 and compatible devices |
| **H02** | `5013` | TCP | H02-protocol devices — common in low-cost personal and vehicle trackers (`*HQ,...#` frame) |
| **Meitrack** | `5020` | TCP | MVT100, MVT340, MVT380, T1, T3, T333, T366, T622, TC68S and other Meitrack series |
| **Queclink** | `5026` | TCP | GV55, GV65, GV300, GV300W, GV500, GV600, GL300, GL500, GB100 and compatible GV/GL/GB series |
| **Flespi** | `5149` | TCP | Any device sending Flespi's unified JSON wire format (newline-delimited) |
| **OsmAnd** | `5055` | TCP (HTTP) | OsmAnd Live tracking app for Android/iOS, or any device sending OsmAnd-compatible HTTP GET requests |
| **Totem** | `5100` | TCP | Totem GPS tracker series |

---

## Protocol Details

### Teltonika

The Teltonika decoder supports Codec 8, 8E, 16, and 26 binary frames over both TCP and UDP. It decodes the full I/O element set including digital inputs, analog inputs, fuel level, battery voltage, ICCID, driver behaviour events (harsh braking, acceleration, cornering), GNSS PDOP/HDOP, and hundreds of other AVL parameters.

**Supported commands:** `cpureset`, `getver`, `getgps`, `readio`, `getrecord`, `getinfo`, `setparam`, `getparam`, `flush`, `readstatus`, `getimei`, `custom` (raw text or hex)

**Device setup:** In Teltonika Configurator, set the server IP and port to your Routario host on port **5027**. Use Codec 8E for best results.

---

### GT06 / Concox

Handles the binary `0x78 0x78` (short packet) and `0x79 0x79` (long packet) frame formats used by GT06 and hundreds of compatible Chinese GPS trackers.

**Supported commands:** `reboot`, `get_info`, `set_interval`, `request_position`, `set_output` (relay), `custom`

---

### Meitrack

Full support for the `$$`-delimited ASCII protocol with optional XOR checksum. Decodes all standard event codes including SOS, power cut, low battery, overspeed, geofence, towing, and tampering as sensor events.

**Supported commands:** `request_position`, `reboot`, `set_interval`, `set_server`, `set_apn`, `set_output`, `set_timezone`, `custom`

---

### Queclink

Decodes ASCII `+RESP:` / `+ACK:` / `+BUFF:` messages. Supports GTFRI position reports and event messages: GTIGN (ignition on), GTIGF (ignition off), GTSOS, GTSPD (overspeed), GTTOW (towing), and more.

**Supported commands:** `reboot`, `get_info`, `set_interval`, `request_position`, `set_output`, `set_apn`, `custom` — sent as `AT+<CMD>=<password>,<params>$`

---

### H02

Decodes V1, V4 (standard position), NBR (cell-tower LBS), HTBT (heartbeat), and LINK (status) message types.

**Supported commands:** `reboot`, `request_position`, `set_interval`, `set_apn`, `arm`, `disarm`, `set_output`, `custom`

---

### OsmAnd

Accepts OsmAnd Live tracking HTTP GET requests and converts them into normalised position records. Useful for tracking smartphones or any device that can POST OsmAnd-compatible requests.

!!! info
    OsmAnd is a receive-only protocol — outbound commands are not supported.

---

### Flespi (native)

Devices that connect directly to Routario using Flespi's unified JSON wire format (newline-delimited JSON objects). Distinct from the [Flespi Cloud integration](integrations.md#flespi-cloud), which polls the Flespi API.

---

## Adding New Protocols

The protocol system is auto-discovering. To add a new decoder:

1. Create a new file in `app/protocols/`.
2. Subclass `BaseProtocolDecoder` and implement `decode()` and optionally `encode_command()`.
3. Decorate the class with `@ProtocolRegistry.register("your_protocol")`.

Routario will automatically start a TCP/UDP server on the port defined by `PORT` at next startup — no changes to `main.py` required.

```python
from . import BaseProtocolDecoder, ProtocolRegistry

@ProtocolRegistry.register("myprotocol")
class MyProtocolDecoder(BaseProtocolDecoder):
    PORT = 5200
    PROTOCOL_TYPES = ['tcp']

    async def decode(self, data, client_info, known_imei=None):
        ...

    async def encode_command(self, command_type, params):
        ...
```
