"""
app/integrations/google_find_hub.py

Google Find Hub integration.

Authentication:
  Requires the contents of Auth/secrets.json from GoogleFindMyTools:
  https://github.com/leonboe1/GoogleFindMyTools

  After running the tool's E2EE location-decryption flow the file also contains
  owner_key used for decrypting location reports.

API:
  Google Nova API (protobuf over HTTPS):
    Device list:      POST /nova/nbe_list_devices
    Location trigger: POST /nova/nbe_execute_action
  Location responses are pushed back via Firebase Cloud Messaging (FCM).

Decryption:
  owner_key (from secrets.json) → per-device identity_key (EIK)
  Own reports:    AES-GCM(sha256(identity_key), encrypted_location)
  Network/crowd:  ECDH(SECP160r1) + AES-EAX
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import AsyncIterator, Optional

import httpx
from google.protobuf import descriptor as _descriptor
from google.protobuf import descriptor_pool as _descriptor_pool
from google.protobuf import symbol_database as _symbol_database
from google.protobuf.internal import builder as _builder

_symbol_database.Default()

_COMMON_PROTO = _descriptor_pool.Default().AddSerializedFile(b'\n\x1aProtoDecoders/Common.proto\"&\n\x04Time\x12\x0f\n\x07seconds\x18\x01 \x01(\r\x12\r\n\x05nanos\x18\x02 \x01(\r\"y\n\x0eLocationReport\x12+\n\x10semanticLocation\x18\x05 \x01(\x0b\x32\x11.SemanticLocation\x12!\n\x0bgeoLocation\x18\n \x01(\x0b\x32\x0c.GeoLocation\x12\x17\n\x06status\x18\x0b \x01(\x0e\x32\x07.Status\"(\n\x10SemanticLocation\x12\x14\n\x0clocationName\x18\x01 \x01(\t\"d\n\x0bGeoLocation\x12)\n\x0f\x65ncryptedReport\x18\x01 \x01(\x0b\x32\x10.EncryptedReport\x12\x18\n\x10\x64\x65viceTimeOffset\x18\x02 \x01(\r\x12\x10\n\x08\x61\x63\x63uracy\x18\x03 \x01(\x02\"Z\n\x0f\x45ncryptedReport\x12\x17\n\x0fpublicKeyRandom\x18\x01 \x01(\x0c\x12\x19\n\x11\x65ncryptedLocation\x18\x02 \x01(\x0c\x12\x13\n\x0bisOwnReport\x18\x03 \x01(\x08\"V\n\x1fGetEidInfoForE2eeDevicesRequest\x12\x17\n\x0fownerKeyVersion\x18\x01 \x01(\x05\x12\x1a\n\x12hasOwnerKeyVersion\x18\x02 \x01(\x08*H\n\x06Status\x12\x0c\n\x08SEMANTIC\x10\x00\x12\x0e\n\nLAST_KNOWN\x10\x01\x12\x10\n\x0c\x43ROWDSOURCED\x10\x02\x12\x0e\n\nAGGREGATED\x10\x03\x62\x06proto3')
_builder.BuildMessageAndEnumDescriptors(_COMMON_PROTO, globals())
_builder.BuildTopDescriptorsAndMessages(_COMMON_PROTO, 'ProtoDecoders.Common_pb2', globals())
if _descriptor._USE_C_DESCRIPTORS == False:
    _COMMON_PROTO._options = None
    globals()['_STATUS']._serialized_start = 517
    globals()['_STATUS']._serialized_end = 589
    globals()['_TIME']._serialized_start = 30
    globals()['_TIME']._serialized_end = 68
    globals()['_LOCATIONREPORT']._serialized_start = 70
    globals()['_LOCATIONREPORT']._serialized_end = 191
    globals()['_SEMANTICLOCATION']._serialized_start = 193
    globals()['_SEMANTICLOCATION']._serialized_end = 233
    globals()['_GEOLOCATION']._serialized_start = 235
    globals()['_GEOLOCATION']._serialized_end = 335
    globals()['_ENCRYPTEDREPORT']._serialized_start = 337
    globals()['_ENCRYPTEDREPORT']._serialized_end = 427
    globals()['_GETEIDINFOFORE2EEDEVICESREQUEST']._serialized_start = 429
    globals()['_GETEIDINFOFORE2EEDEVICESREQUEST']._serialized_end = 515

_DU_PROTO = _descriptor_pool.Default().AddSerializedFile(b'\n ProtoDecoders/DeviceUpdate.proto\x1a\x1aProtoDecoders/Common.proto\"g\n GetEidInfoForE2eeDevicesResponse\x12\x43\n\x1c\x65ncryptedOwnerKeyAndMetadata\x18\x04 \x01(\x0b\x32\x1d.EncryptedOwnerKeyAndMetadata\"j\n\x1c\x45ncryptedOwnerKeyAndMetadata\x12\x19\n\x11\x65ncryptedOwnerKey\x18\x01 \x01(\x0c\x12\x17\n\x0fownerKeyVersion\x18\x02 \x01(\x05\x12\x16\n\x0esecurityDomain\x18\x03 \x01(\t\"6\n\x0b\x44\x65vicesList\x12\'\n\x0e\x64\x65viceMetadata\x18\x02 \x03(\x0b\x32\x0f.DeviceMetadata\"R\n\x12\x44\x65vicesListRequest\x12<\n\x18\x64\x65viceListRequestPayload\x18\x01 \x01(\x0b\x32\x1a.DevicesListRequestPayload\"B\n\x19\x44\x65vicesListRequestPayload\x12\x19\n\x04type\x18\x01 \x01(\x0e\x32\x0b.DeviceType\x12\n\n\x02id\x18\x03 \x01(\t\"\x96\x01\n\x14\x45xecuteActionRequest\x12\"\n\x05scope\x18\x01 \x01(\x0b\x32\x13.ExecuteActionScope\x12\"\n\x06\x61\x63tion\x18\x02 \x01(\x0b\x32\x12.ExecuteActionType\x12\x36\n\x0frequestMetadata\x18\x03 \x01(\x0b\x32\x1d.ExecuteActionRequestMetadata\"\xaf\x01\n\x1c\x45xecuteActionRequestMetadata\x12\x19\n\x04type\x18\x01 \x01(\x0e\x32\x0b.DeviceType\x12\x13\n\x0brequestUuid\x18\x02 \x01(\t\x12\x15\n\rfmdClientUuid\x18\x03 \x01(\t\x12\x37\n\x11gcmRegistrationId\x18\x04 \x01(\x0b\x32\x1c.GcmCloudMessagingIdProtobuf\x12\x0f\n\x07unknown\x18\x06 \x01(\x08\")\n\x1bGcmCloudMessagingIdProtobuf\x12\n\n\x02id\x18\x01 \x01(\t\"\xa4\x01\n\x11\x45xecuteActionType\x12\x36\n\rlocateTracker\x18\x1e \x01(\x0b\x32\x1f.ExecuteActionLocateTrackerType\x12+\n\nstartSound\x18\x1f \x01(\x0b\x32\x17.ExecuteActionSoundType\x12*\n\tstopSound\x18  \x01(\x0b\x32\x17.ExecuteActionSoundType\"{\n\x1e\x45xecuteActionLocateTrackerType\x12*\n\x1blastHighTrafficEnablingTime\x18\x02 \x01(\x0b\x32\x05.Time\x12-\n\x0f\x63ontributorType\x18\x03 \x01(\x0e\x32\x14.SpotContributorType\"=\n\x16\x45xecuteActionSoundType\x12#\n\tcomponent\x18\x01 \x01(\x0e\x32\x10.DeviceComponent\"_\n\x12\x45xecuteActionScope\x12\x19\n\x04type\x18\x02 \x01(\x0e\x32\x0b.DeviceType\x12.\n\x06\x64\x65vice\x18\x03 \x01(\x0b\x32\x1e.ExecuteActionDeviceIdentifier\">\n\x1d\x45xecuteActionDeviceIdentifier\x12\x1d\n\tcanonicId\x18\x01 \x01(\x0b\x32\n.CanonicId\"\x96\x01\n\x0c\x44\x65viceUpdate\x12\x32\n\x0b\x66\x63mMetadata\x18\x01 \x01(\x0b\x32\x1d.ExecuteActionRequestMetadata\x12\'\n\x0e\x64\x65viceMetadata\x18\x03 \x01(\x0b\x32\x0f.DeviceMetadata\x12)\n\x0frequestMetadata\x18\x02 \x01(\x0b\x32\x10.RequestMetadata\"\xbd\x01\n\x0e\x44\x65viceMetadata\x12\x36\n\x15identifierInformation\x18\x01 \x01(\x0b\x32\x17.IdentitfierInformation\x12\'\n\x0binformation\x18\x04 \x01(\x0b\x32\x12.DeviceInformation\x12\x1d\n\x15userDefinedDeviceName\x18\x05 \x01(\t\x12+\n\x10imageInformation\x18\x06 \x01(\x0b\x32\x11.ImageInformation\"$\n\x10ImageInformation\x12\x10\n\x08imageUrl\x18\x01 \x01(\t\"\x90\x01\n\x16IdentitfierInformation\x12+\n\x10phoneInformation\x18\x01 \x01(\x0b\x32\x11.PhoneInformation\x12(\n\x04type\x18\x02 \x01(\x0e\x32\x1a.IdentifierInformationType\x12\x1f\n\ncanonicIds\x18\x03 \x01(\x0b\x32\x0b.CanonicIds\"3\n\x10PhoneInformation\x12\x1f\n\ncanonicIds\x18\x02 \x01(\x0b\x32\x0b.CanonicIds\"+\n\nCanonicIds\x12\x1d\n\tcanonicId\x18\x01 \x03(\x0b\x32\n.CanonicId\"\x17\n\tCanonicId\x12\n\n\x02id\x18\x01 \x01(\t\"\xa6\x01\n\x11\x44\x65viceInformation\x12/\n\x12\x64\x65viceRegistration\x18\x01 \x01(\x0b\x32\x13.DeviceRegistration\x12\x31\n\x13locationInformation\x18\x02 \x01(\x0b\x32\x14.LocationInformation\x12-\n\x11\x61\x63\x63\x65ssInformation\x18\x03 \x03(\x0b\x32\x12.AccessInformation\"<\n\x15\x44\x65viceTypeInformation\x12#\n\ndeviceType\x18\x02 \x01(\x0e\x32\x0f.SpotDeviceType\"\xd0\x01\n\x12\x44\x65viceRegistration\x12\x35\n\x15\x64\x65viceTypeInformation\x18\x02 \x01(\x0b\x32\x16.DeviceTypeInformation\x12\x33\n\x14\x65ncryptedUserSecrets\x18\x13 \x01(\x0b\x32\x15.EncryptedUserSecrets\x12\x14\n\x0cmanufacturer\x18\x14 \x01(\t\x12\x17\n\x0f\x66\x61stPairModelId\x18\x15 \x01(\t\x12\x10\n\x08pairDate\x18\x17 \x01(\x05\x12\r\n\x05model\x18\" \x01(\t\"\xb7\x01\n\x14\x45ncryptedUserSecrets\x12\x1c\n\x14\x65ncryptedIdentityKey\x18\x01 \x01(\x0c\x12\x17\n\x0fownerKeyVersion\x18\x03 \x01(\x05\x12\x1b\n\x13\x65ncryptedAccountKey\x18\x04 \x01(\x0c\x12\x1b\n\x0c\x63reationDate\x18\x08 \x01(\x0b\x32\x05.Time\x12.\n&encryptedSha256AccountKeyPublicAddress\x18\x0b \x01(\x0c\"F\n\x13LocationInformation\x12/\n\x07reports\x18\x03 \x01(\x0b\x32\x1e.LocationsAndTimestampsWrapper\"n\n\x1dLocationsAndTimestampsWrapper\x12M\n!recentLocationAndNetworkLocations\x18\x04 \x01(\x0b\x32\".RecentLocationAndNetworkLocations\"\xf3\x01\n!RecentLocationAndNetworkLocations\x12\'\n\x0erecentLocation\x18\x01 \x01(\x0b\x32\x0f.LocationReport\x12&\n\x17recentLocationTimestamp\x18\x02 \x01(\x0b\x32\x05.Time\x12)\n\x10networkLocations\x18\x05 \x03(\x0b\x32\x0f.LocationReport\x12(\n\x19networkLocationTimestamps\x18\x06 \x03(\x0b\x32\x05.Time\x12(\n minLocationsNeededForAggregation\x18\t \x01(\r\"[\n\x11\x41\x63\x63\x65ssInformation\x12\r\n\x05\x65mail\x18\x01 \x01(\t\x12\x11\n\thasAccess\x18\x02 \x01(\x08\x12\x0f\n\x07isOwner\x18\x03 \x01(\x08\x12\x13\n\x0bthisAccount\x18\x04 \x01(\x08\".\n\x0fRequestMetadata\x12\x1b\n\x0cresponseTime\x18\x01 \x01(\x0b\x32\x05.Time\"n\n\x1d\x45ncryptionUnlockRequestExtras\x12\x11\n\toperation\x18\x01 \x01(\x05\x12\'\n\x0esecurityDomain\x18\x02 \x01(\x0b\x32\x0f.SecurityDomain\x12\x11\n\tsessionId\x18\x06 \x01(\t\"/\n\x0eSecurityDomain\x12\x0c\n\x04name\x18\x01 \x01(\t\x12\x0f\n\x07unknown\x18\x02 \x01(\x05\"A\n\x08Location\x12\x10\n\x08latitude\x18\x01 \x01(\x0f\x12\x11\n\tlongitude\x18\x02 \x01(\x0f\x12\x10\n\x08\x61ltitude\x18\x03 \x01(\x05\"\xb6\x02\n\x18RegisterBleDeviceRequest\x12\x17\n\x0f\x66\x61stPairModelId\x18\x07 \x01(\t\x12\'\n\x0b\x64\x65scription\x18\n \x01(\x0b\x32\x12.DeviceDescription\x12)\n\x0c\x63\x61pabilities\x18\x0b \x01(\x0b\x32\x13.DeviceCapabilities\x12=\n\x19\x65\x32\x65\x65PublicKeyRegistration\x18\x10 \x01(\x0b\x32\x1a.E2EEPublicKeyRegistration\x12\x18\n\x10manufacturerName\x18\x11 \x01(\t\x12\x0f\n\x07ringKey\x18\x15 \x01(\x0c\x12\x13\n\x0brecoveryKey\x18\x16 \x01(\x0c\x12\x1b\n\x13unwantedTrackingKey\x18\x18 \x01(\x0c\x12\x11\n\tmodelName\x18\x19 \x01(\t\"\xaa\x01\n\x19\x45\x32\x45\x45PublicKeyRegistration\x12\x18\n\x10rotationExponent\x18\x01 \x01(\x05\x12\x33\n\x14\x65ncryptedUserSecrets\x18\x03 \x01(\x0b\x32\x15.EncryptedUserSecrets\x12)\n\x0fpublicKeyIdList\x18\x04 \x01(\x0b\x32\x10.PublicKeyIdList\x12\x13\n\x0bpairingDate\x18\x05 \x01(\x05\"\xb9\x01\n\x0fPublicKeyIdList\x12\x39\n\x0fpublicKeyIdInfo\x18\x01 \x03(\x0b\x32 .PublicKeyIdList.PublicKeyIdInfo\x1ak\n\x0fPublicKeyIdInfo\x12\x18\n\ttimestamp\x18\x01 \x01(\x0b\x32\x05.Time\x12\"\n\x0bpublicKeyId\x18\x02 \x01(\x0b\x32\r.TruncatedEID\x12\x1a\n\x12trackableComponent\x18\x03 \x01(\x05\"$\n\x0cTruncatedEID\x12\x14\n\x0ctruncatedEid\x18\x01 \x01(\x0c\"\xe1\x01\n$UploadPrecomputedPublicKeyIdsRequest\x12L\n\ndeviceEids\x18\x01 \x03(\x0b\x32\x38.UploadPrecomputedPublicKeyIdsRequest.DevicePublicKeyIds\x1ak\n\x12\x44\x65vicePublicKeyIds\x12\x1d\n\tcanonicId\x18\x01 \x01(\x0b\x32\n.CanonicId\x12$\n\nclientList\x18\x02 \x01(\x0b\x32\x10.PublicKeyIdList\x12\x10\n\x08pairDate\x18\x03 \x01(\x05\"c\n\x12\x44\x65viceCapabilities\x12\x15\n\risAdvertising\x18\x01 \x01(\x08\x12\x19\n\x11\x63\x61pableComponents\x18\x05 \x01(\x05\x12\x1b\n\x13trackableComponents\x18\x06 \x01(\x05\"\x93\x01\n\x11\x44\x65viceDescription\x12\x17\n\x0fuserDefinedName\x18\x01 \x01(\t\x12#\n\ndeviceType\x18\x02 \x01(\x0e\x32\x0f.SpotDeviceType\x12@\n\x1b\x64\x65viceComponentsInformation\x18\t \x03(\x0b\x32\x1b.DeviceComponentInformation\".\n\x1a\x44\x65viceComponentInformation\x12\x10\n\x08imageUrl\x18\x01 \x01(\t*\xa5\x01\n\nDeviceType\x12\x17\n\x13UNKNOWN_DEVICE_TYPE\x10\x00\x12\x12\n\x0e\x41NDROID_DEVICE\x10\x01\x12\x0f\n\x0bSPOT_DEVICE\x10\x02\x12\x14\n\x10TEST_DEVICE_TYPE\x10\x03\x12\x0f\n\x0b\x41UTO_DEVICE\x10\x04\x12\x13\n\x0f\x46\x41STPAIR_DEVICE\x10\x05\x12\x1d\n\x19SUPERVISED_ANDROID_DEVICE\x10\x07*\xa6\x01\n\x13SpotContributorType\x12\x19\n\x15\x46MDN_DISABLED_DEFAULT\x10\x00\x12!\n\x1d\x46MDN_CONTRIBUTOR_HIGH_TRAFFIC\x10\x03\x12\"\n\x1e\x46MDN_CONTRIBUTOR_ALL_LOCATIONS\x10\x04\x12\x15\n\x11\x46MDN_HIGH_TRAFFIC\x10\x01\x12\x16\n\x12\x46MDN_ALL_LOCATIONS\x10\x02*\x85\x01\n\x0f\x44\x65viceComponent\x12 \n\x1c\x44\x45VICE_COMPONENT_UNSPECIFIED\x10\x00\x12\x1a\n\x16\x44\x45VICE_COMPONENT_RIGHT\x10\x01\x12\x19\n\x15\x44\x45VICE_COMPONENT_LEFT\x10\x02\x12\x19\n\x15\x44\x45VICE_COMPONENT_CASE\x10\x03*`\n\x19IdentifierInformationType\x12\x16\n\x12IDENTIFIER_UNKNOWN\x10\x00\x12\x16\n\x12IDENTIFIER_ANDROID\x10\x01\x12\x13\n\x0fIDENTIFIER_SPOT\x10\x02*\x82\x05\n\x0eSpotDeviceType\x12\x17\n\x13\x44\x45VICE_TYPE_UNKNOWN\x10\x00\x12\x16\n\x12\x44\x45VICE_TYPE_BEACON\x10\x01\x12\x1a\n\x16\x44\x45VICE_TYPE_HEADPHONES\x10\x02\x12\x14\n\x10\x44\x45VICE_TYPE_KEYS\x10\x03\x12\x15\n\x11\x44\x45VICE_TYPE_WATCH\x10\x04\x12\x16\n\x12\x44\x45VICE_TYPE_WALLET\x10\x05\x12\x13\n\x0f\x44\x45VICE_TYPE_BAG\x10\x07\x12\x16\n\x12\x44\x45VICE_TYPE_LAPTOP\x10\x08\x12\x13\n\x0f\x44\x45VICE_TYPE_CAR\x10\t\x12\x1e\n\x1a\x44\x45VICE_TYPE_REMOTE_CONTROL\x10\n\x12\x15\n\x11\x44\x45VICE_TYPE_BADGE\x10\x0b\x12\x14\n\x10\x44\x45VICE_TYPE_BIKE\x10\x0c\x12\x16\n\x12\x44\x45VICE_TYPE_CAMERA\x10\r\x12\x13\n\x0f\x44\x45VICE_TYPE_CAT\x10\x0e\x12\x17\n\x13\x44\x45VICE_TYPE_CHARGER\x10\x0f\x12\x18\n\x14\x44\x45VICE_TYPE_CLOTHING\x10\x10\x12\x13\n\x0f\x44\x45VICE_TYPE_DOG\x10\x11\x12\x18\n\x14\x44\x45VICE_TYPE_NOTEBOOK\x10\x12\x12\x18\n\x14\x44\x45VICE_TYPE_PASSPORT\x10\x13\x12\x15\n\x11\x44\x45VICE_TYPE_PHONE\x10\x14\x12\x17\n\x13\x44\x45VICE_TYPE_SPEAKER\x10\x15\x12\x16\n\x12\x44\x45VICE_TYPE_TABLET\x10\x16\x12\x13\n\x0f\x44\x45VICE_TYPE_TOY\x10\x17\x12\x18\n\x14\x44\x45VICE_TYPE_UMBRELLA\x10\x18\x12\x16\n\x12\x44\x45VICE_TYPE_STYLUS\x10\x19\x12\x17\n\x13\x44\x45VICE_TYPE_EARBUDS\x10\x1a\x62\x06proto3')
_builder.BuildMessageAndEnumDescriptors(_DU_PROTO, globals())
_builder.BuildTopDescriptorsAndMessages(_DU_PROTO, 'ProtoDecoders.DeviceUpdate_pb2', globals())
if _descriptor._USE_C_DESCRIPTORS == False:
    _DU_PROTO._options = None
    globals()['_DEVICETYPE']._serialized_start = 4695
    globals()['_DEVICETYPE']._serialized_end = 4860
    globals()['_SPOTCONTRIBUTORTYPE']._serialized_start = 4863
    globals()['_SPOTCONTRIBUTORTYPE']._serialized_end = 5029
    globals()['_DEVICECOMPONENT']._serialized_start = 5032
    globals()['_DEVICECOMPONENT']._serialized_end = 5165
    globals()['_IDENTIFIERINFORMATIONTYPE']._serialized_start = 5167
    globals()['_IDENTIFIERINFORMATIONTYPE']._serialized_end = 5263
    globals()['_SPOTDEVICETYPE']._serialized_start = 5266
    globals()['_SPOTDEVICETYPE']._serialized_end = 5908
    globals()['_GETEIDINFOFORE2EEDEVICESRESPONSE']._serialized_start = 64
    globals()['_GETEIDINFOFORE2EEDEVICESRESPONSE']._serialized_end = 167
    globals()['_ENCRYPTEDOWNERKEYANDMETADATA']._serialized_start = 169
    globals()['_ENCRYPTEDOWNERKEYANDMETADATA']._serialized_end = 275
    globals()['_DEVICESLIST']._serialized_start = 277
    globals()['_DEVICESLIST']._serialized_end = 331
    globals()['_DEVICESLISTREQUEST']._serialized_start = 333
    globals()['_DEVICESLISTREQUEST']._serialized_end = 415
    globals()['_DEVICESLISTREQUESTPAYLOAD']._serialized_start = 417
    globals()['_DEVICESLISTREQUESTPAYLOAD']._serialized_end = 483
    globals()['_EXECUTEACTIONREQUEST']._serialized_start = 486
    globals()['_EXECUTEACTIONREQUEST']._serialized_end = 636
    globals()['_EXECUTEACTIONREQUESTMETADATA']._serialized_start = 639
    globals()['_EXECUTEACTIONREQUESTMETADATA']._serialized_end = 814
    globals()['_GCMCLOUDMESSAGINGIDPROTOBUF']._serialized_start = 816
    globals()['_GCMCLOUDMESSAGINGIDPROTOBUF']._serialized_end = 857
    globals()['_EXECUTEACTIONTYPE']._serialized_start = 860
    globals()['_EXECUTEACTIONTYPE']._serialized_end = 1024
    globals()['_EXECUTEACTIONLOCATETRACKERTYPE']._serialized_start = 1026
    globals()['_EXECUTEACTIONLOCATETRACKERTYPE']._serialized_end = 1149
    globals()['_EXECUTEACTIONSOUNDTYPE']._serialized_start = 1151
    globals()['_EXECUTEACTIONSOUNDTYPE']._serialized_end = 1212
    globals()['_EXECUTEACTIONSCOPE']._serialized_start = 1214
    globals()['_EXECUTEACTIONSCOPE']._serialized_end = 1309
    globals()['_EXECUTEACTIONDEVICEIDENTIFIER']._serialized_start = 1311
    globals()['_EXECUTEACTIONDEVICEIDENTIFIER']._serialized_end = 1373
    globals()['_DEVICEUPDATE']._serialized_start = 1376
    globals()['_DEVICEUPDATE']._serialized_end = 1526
    globals()['_DEVICEMETADATA']._serialized_start = 1529
    globals()['_DEVICEMETADATA']._serialized_end = 1718
    globals()['_IMAGEINFORMATION']._serialized_start = 1720
    globals()['_IMAGEINFORMATION']._serialized_end = 1756
    globals()['_IDENTITFIERINFORMATION']._serialized_start = 1759
    globals()['_IDENTITFIERINFORMATION']._serialized_end = 1903
    globals()['_PHONEINFORMATION']._serialized_start = 1905
    globals()['_PHONEINFORMATION']._serialized_end = 1956
    globals()['_CANONICIDS']._serialized_start = 1958
    globals()['_CANONICIDS']._serialized_end = 2001
    globals()['_CANONICID']._serialized_start = 2003
    globals()['_CANONICID']._serialized_end = 2026
    globals()['_DEVICEINFORMATION']._serialized_start = 2029
    globals()['_DEVICEINFORMATION']._serialized_end = 2195
    globals()['_DEVICETYPEINFORMATION']._serialized_start = 2197
    globals()['_DEVICETYPEINFORMATION']._serialized_end = 2257
    globals()['_DEVICEREGISTRATION']._serialized_start = 2260
    globals()['_DEVICEREGISTRATION']._serialized_end = 2468
    globals()['_ENCRYPTEDUSERSECRETS']._serialized_start = 2471
    globals()['_ENCRYPTEDUSERSECRETS']._serialized_end = 2654
    globals()['_LOCATIONINFORMATION']._serialized_start = 2656
    globals()['_LOCATIONINFORMATION']._serialized_end = 2726
    globals()['_LOCATIONSANDTIMESTAMPSWRAPPER']._serialized_start = 2728
    globals()['_LOCATIONSANDTIMESTAMPSWRAPPER']._serialized_end = 2838
    globals()['_RECENTLOCATIONANDNETWORKLOCATIONS']._serialized_start = 2841
    globals()['_RECENTLOCATIONANDNETWORKLOCATIONS']._serialized_end = 3084
    globals()['_ACCESSINFORMATION']._serialized_start = 3086
    globals()['_ACCESSINFORMATION']._serialized_end = 3177
    globals()['_REQUESTMETADATA']._serialized_start = 3179
    globals()['_REQUESTMETADATA']._serialized_end = 3225
    globals()['_ENCRYPTIONUNLOCKREQUESTEXTRAS']._serialized_start = 3227
    globals()['_ENCRYPTIONUNLOCKREQUESTEXTRAS']._serialized_end = 3337
    globals()['_SECURITYDOMAIN']._serialized_start = 3339
    globals()['_SECURITYDOMAIN']._serialized_end = 3386
    globals()['_LOCATION']._serialized_start = 3388
    globals()['_LOCATION']._serialized_end = 3453
    globals()['_REGISTERBLEDEVICEREQUEST']._serialized_start = 3456
    globals()['_REGISTERBLEDEVICEREQUEST']._serialized_end = 3766
    globals()['_E2EEPUBLICKEYREGISTRATION']._serialized_start = 3769
    globals()['_E2EEPUBLICKEYREGISTRATION']._serialized_end = 3939
    globals()['_PUBLICKEYIDLIST']._serialized_start = 3942
    globals()['_PUBLICKEYIDLIST']._serialized_end = 4127
    globals()['_PUBLICKEYIDLIST_PUBLICKEYIDINFO']._serialized_start = 4020
    globals()['_PUBLICKEYIDLIST_PUBLICKEYIDINFO']._serialized_end = 4127
    globals()['_TRUNCATEDEID']._serialized_start = 4129
    globals()['_TRUNCATEDEID']._serialized_end = 4165
    globals()['_UPLOADPRECOMPUTEDPUBLICKEYIDSREQUEST']._serialized_start = 4168
    globals()['_UPLOADPRECOMPUTEDPUBLICKEYIDSREQUEST']._serialized_end = 4393
    globals()['_UPLOADPRECOMPUTEDPUBLICKEYIDSREQUEST_DEVICEPUBLICKEYIDS']._serialized_start = 4286
    globals()['_UPLOADPRECOMPUTEDPUBLICKEYIDSREQUEST_DEVICEPUBLICKEYIDS']._serialized_end = 4393
    globals()['_DEVICECAPABILITIES']._serialized_start = 4395
    globals()['_DEVICECAPABILITIES']._serialized_end = 4494
    globals()['_DEVICEDESCRIPTION']._serialized_start = 4497
    globals()['_DEVICEDESCRIPTION']._serialized_end = 4644
    globals()['_DEVICECOMPONENTINFORMATION']._serialized_start = 4646
    globals()['_DEVICECOMPONENTINFORMATION']._serialized_end = 4692

from firebase_messaging import FcmRegisterConfig, FcmPushClient
from integrations.base import (
    BaseIntegration, AuthContext, AuthExpiredError,
    IntegrationField, RemoteDevice,
)
from integrations.registry import IntegrationRegistry
from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)

_CLIENT_SIG    = "38918a453d07199354f8b19af05ec6562ced5788"
_BUNDLE_ID     = "com.google.android.apps.adm"
_NOVA_BASE     = "https://android.googleapis.com/nova/"
_MCU_MODEL_ID  = "003200"                    # custom ESP32/Zephyr trackers need bit-flipped EIK

# Static client UUID — identifies this Routario instance to Google
_FMDN_CLIENT_UUID = "routario-find-hub-integration"

# Per-account last-seen dedup
_last_seen: dict[tuple, datetime] = {}

# --- FCM state (module-level, one client per account) -------------------------
_fcm_clients: dict[str, object]   = {}       # username → FcmPushClient
_fcm_tokens:  dict[str, str]      = {}       # username → FCM registration token
_pending:               dict[tuple, asyncio.Future] = {}  # (username, request_uuid) → Future
_fcm_no_response_count: dict[str, int]            = {}  # username → consecutive empty polls
_FCM_RESTART_THRESHOLD = 5


def _make_fcm_config():
    return FcmRegisterConfig(
        project_id="google.com:api-project-289722593072",
        app_id="1:289722593072:android:3cfcf5bc359f0308",
        api_key="AIzaSyD_gko3P392v6how2H7UpdeXQ0v2HLettc",
        messaging_sender_id="289722593072",
        bundle_id=_BUNDLE_ID,
    )


def _on_fcm_notification(username: str, obj):
    """Called by FcmPushClient whenever an FCM notification arrives."""
    if not isinstance(obj, dict):
        return
    data = obj.get("data") or {}
    b64_payload = data.get("com.google.android.apps.adm.FCM_PAYLOAD")
    if not b64_payload:
        return

    try:
        raw = base64.b64decode(b64_payload)
        device_update = DeviceUpdate()
        device_update.ParseFromString(raw)
        request_uuid = device_update.fcmMetadata.requestUuid
    except Exception as e:
        logger.error("Google Find Hub: FCM payload parse error: %s", e)
        return

    key    = (username, request_uuid)
    future = _pending.get(key)
    if future and not future.done():
        try:
            future.set_result(device_update)
        except Exception:
            pass


async def _start_fcm_client(username: str, fcm_credentials: dict) -> str:
    """Start (or reuse) the FCM listener for this account. Returns the FCM token."""
    if username in _fcm_clients:
        return _fcm_tokens.get(username, "")

    def _callback(obj, notification, ctx):
        _on_fcm_notification(username, obj)

    client = FcmPushClient(
        callback=_callback,
        fcm_config=_make_fcm_config(),
        credentials=fcm_credentials,
    )
    fcm_token = await client.checkin_or_register()
    await client.start()

    _fcm_clients[username] = client
    _fcm_tokens[username]  = fcm_token
    logger.info("Google Find Hub: FCM listener started for %s (token=…%s)", username, fcm_token[-12:])
    return fcm_token


async def stop_all_fcm_clients() -> None:
    """Stop every active FCM listener. Call during server shutdown."""
    for username, client in list(_fcm_clients.items()):
        if hasattr(client, "stop"):
            try:
                await client.stop()
                logger.debug("Google Find Hub: FCM client stopped for %s", username)
            except Exception:
                pass
    _fcm_clients.clear()
    _fcm_tokens.clear()
    _fcm_no_response_count.clear()


@IntegrationRegistry.register("google_find_hub")
class GoogleFindHubIntegration(BaseIntegration):

    PROVIDER_ID                  = "google_find_hub"
    DISPLAY_NAME                 = "Google Find Hub"
    POLL_INTERVAL_SECONDS        = 300
    POLL_INTERVAL_ACTIVE_SECONDS = 120

    FIELDS = [
        IntegrationField(
            key="secrets_json",
            label="secrets.json contents",
            field_type="textarea",
            required=True,
            placeholder='{"username": "you@gmail.com", "aas_token": "…", "fcm_credentials": {…}}',
            help_text=(
                "Paste the full contents of Auth/secrets.json generated by GoogleFindMyTools "
                "(github.com/leonboe1/GoogleFindMyTools). "
                "After running the tool's location flow, secrets.json also contains owner_key "
                "which enables E2EE location decryption."
            ),
        ),
    ]

    # ── Auth ──────────────────────────────────────────────────────────────────

    async def authenticate(self, credentials: dict) -> AuthContext:
        raw = credentials.get("secrets_json", "")
        try:
            secrets = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f"Google Find Hub: secrets_json is not valid JSON: {e}")
        if not secrets.get("aas_token"):
            raise ValueError(
                "Google Find Hub: secrets_json must contain an aas_token. "
                "Generate it with GoogleFindMyTools (github.com/leonboe1/GoogleFindMyTools)."
            )
        return await self._auth_from_secrets(secrets)

    async def _auth_from_secrets(self, secrets: dict) -> AuthContext:
        import gpsoauth

        username   = secrets.get("username") or secrets.get("email") or ""
        aas_token  = secrets["aas_token"]
        android_id = str(
            secrets.get("android_id")
            or (secrets.get("fcm_credentials") or {}).get("gcm", {}).get("android_id")
            or ""
        )
        if not android_id:
            raise ValueError("Google Find Hub: no android_id found in secrets.json.")

        adm_resp = gpsoauth.perform_oauth(
            username, aas_token, android_id,
            service="oauth2:https://www.googleapis.com/auth/android_device_manager",
            app=_BUNDLE_ID,
            client_sig=_CLIENT_SIG,
        )
        access_token = adm_resp.get("Auth")
        if not access_token:
            raise AuthExpiredError(f"Google Find Hub: AAS token exchange failed: {adm_resp}")

        owner_key: Optional[bytes] = None
        owner_key_hex = secrets.get("owner_key") or ""
        if owner_key_hex:
            try:
                owner_key = bytes.fromhex(owner_key_hex)
            except ValueError:
                logger.warning("Google Find Hub: owner_key is not valid hex — ignoring")

        # Start FCM listener (needed to receive location push responses)
        fcm_credentials = secrets.get("fcm_credentials")
        fcm_token = ""
        if fcm_credentials:
            try:
                fcm_token = await _start_fcm_client(username, fcm_credentials)
            except Exception as e:
                logger.error("Google Find Hub: FCM listener failed to start: %s", e, exc_info=True)
        else:
            logger.warning("Google Find Hub: no fcm_credentials in secrets.json — location fetching unavailable")

        logger.info(
            "Google Find Hub: authenticated as %s (owner_key=%s, fcm=%s)",
            username,
            "present" if owner_key else "absent",
            "ok" if fcm_token else "unavailable",
        )

        return AuthContext(
            data={
                "username":        username,
                "access_token":    access_token,
                "owner_key":       owner_key,
                "fcm_token":       fcm_token,
                "fcm_credentials": fcm_credentials,
            },
            token_expires_at=datetime.now(timezone.utc) + timedelta(seconds=3500),
        )

    # ── List devices ──────────────────────────────────────────────────────────

    async def list_remote_devices(self, auth_ctx: AuthContext) -> list[RemoteDevice]:
        try:
            metas = await self._nova_list_devices(auth_ctx.data["access_token"])
        except Exception as e:
            logger.error("Google Find Hub: list_remote_devices error: %s", e, exc_info=True)
            return []

        result = []
        for meta in metas:
            for cid in _canonic_ids(meta):
                result.append(RemoteDevice(
                    remote_id=cid,
                    name=meta.userDefinedDeviceName or cid,
                    imei=None,
                ))
        return result

    # ── Fetch positions ───────────────────────────────────────────────────────

    async def fetch_positions(
        self,
        auth_ctx: AuthContext,
        devices: list[dict],
    ) -> AsyncIterator[NormalizedPosition]:
        if not devices:
            return

        access_token = auth_ctx.data["access_token"]
        owner_key    = auth_ctx.data.get("owner_key")
        fcm_token    = auth_ctx.data.get("fcm_token", "")
        username     = auth_ctx.data["username"]

        if not fcm_token:
            logger.warning("Google Find Hub: no FCM token — cannot request locations")
            return
        if not owner_key:
            logger.warning(
                "Google Find Hub: no owner_key — run GoogleFindMyTools location flow "
                "and re-paste the updated secrets.json"
            )
            return

        wanted = {d["remote_id"]: d for d in devices if d.get("remote_id")}
        if not wanted:
            return

        # Prune _last_seen entries older than 24 hours to prevent unbounded growth
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        for k in [k for k, ts in _last_seen.items() if ts < cutoff]:
            del _last_seen[k]

        # Send locate requests for all devices in parallel, then collect responses concurrently
        request_map: dict[str, tuple[str, asyncio.Future]] = {}
        loop = asyncio.get_running_loop()

        for canonic_id in wanted:
            req_uuid                       = str(uuid.uuid4())
            future                         = loop.create_future()
            _pending[(username, req_uuid)] = future
            request_map[canonic_id]        = (req_uuid, future)

        # Fire all locate-action requests
        for canonic_id, (req_uuid, _) in request_map.items():
            try:
                await self._send_locate_action(access_token, canonic_id, fcm_token, req_uuid)
            except AuthExpiredError:
                raise
            except Exception as e:
                logger.warning("Google Find Hub: locate-action failed for %s: %s", canonic_id, e)

        # Wait for all responses concurrently (each gets its own 30 s + one retry)
        collect_tasks = [
            self._collect_device_update(username, access_token, cid, fcm_token, req_uuid, future)
            for cid, (req_uuid, future) in request_map.items()
        ]
        results: list[tuple[str, object]] = await asyncio.gather(*collect_tasks)

        any_received = False
        for canonic_id, device_update in results:
            if device_update is None:
                continue
            any_received = True

            device_row = wanted[canonic_id]
            imei       = device_row.get("imei", "")

            location = _decrypt_device_update(device_update, owner_key, canonic_id)
            if location is None:
                continue

            ts = location["timestamp"]
            dk = (username, canonic_id)
            if _last_seen.get(dk, datetime.min.replace(tzinfo=timezone.utc)) >= ts:
                logger.debug("Google Find Hub: duplicate position skipped for %s", canonic_id)
                continue
            _last_seen[dk] = ts

            sensors: dict = {}
            if location.get("accuracy") is not None:
                sensors["accuracy_m"] = location["accuracy"]
            if location.get("source"):
                sensors["location_source"] = location["source"]

            yield NormalizedPosition(
                imei=imei,
                device_time=ts,
                server_time=datetime.now(timezone.utc),
                latitude=location["latitude"],
                longitude=location["longitude"],
                altitude=location.get("altitude"),
                speed=None,
                course=None,
                satellites=None,
                ignition=None,
                sensors=sensors,
                raw_data={"source": "google_find_hub", "canonic_id": canonic_id},
            )

        # Restart FCM client after consecutive empty polls — likely a dead connection
        if not any_received:
            _fcm_no_response_count[username] = _fcm_no_response_count.get(username, 0) + 1
            if _fcm_no_response_count[username] >= _FCM_RESTART_THRESHOLD:
                logger.warning(
                    "Google Find Hub: restarting FCM client for %s after %d consecutive empty polls",
                    username, _FCM_RESTART_THRESHOLD,
                )
                old_client = _fcm_clients.pop(username, None)
                _fcm_tokens.pop(username, None)
                _fcm_no_response_count[username] = 0
                if old_client and hasattr(old_client, "stop"):
                    try:
                        await old_client.stop()
                    except Exception:
                        pass
                fcm_creds = auth_ctx.data.get("fcm_credentials")
                if fcm_creds:
                    try:
                        new_token = await _start_fcm_client(username, fcm_creds)
                        auth_ctx.data["fcm_token"] = new_token
                    except Exception as e:
                        logger.error("Google Find Hub: FCM restart failed for %s: %s", username, e)
        else:
            _fcm_no_response_count[username] = 0

    # ── Credentials test ──────────────────────────────────────────────────────

    async def test_credentials(self, credentials: dict) -> tuple[bool, str]:
        try:
            ctx     = await self.authenticate(credentials)
            devices = await self.list_remote_devices(ctx)
            key_msg = "present" if ctx.data.get("owner_key") else "absent (run GoogleFindMyTools location flow)"
            fcm_msg = "ok" if ctx.data.get("fcm_token") else "unavailable"
            return True, (
                f"Connected as {ctx.data['username']} — "
                f"{len(devices)} device(s), owner_key: {key_msg}, FCM: {fcm_msg}."
            )
        except Exception as e:
            return False, str(e)

    # ── Nova API ──────────────────────────────────────────────────────────────

    async def _nova_post(self, access_token: str, scope: str, payload: bytes) -> bytes:
        headers = {
            "Content-Type":    "application/x-www-form-urlencoded; charset=UTF-8",
            "Authorization":   f"Bearer {access_token}",
            "Accept-Language": "en-US",
            "User-Agent":      "fmd/20006320; gzip",
        }
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(_NOVA_BASE + scope, headers=headers, content=payload)

        if resp.status_code == 401:
            raise AuthExpiredError("Google Find Hub: access token rejected")
        if resp.status_code != 200:
            raise RuntimeError(f"Google Find Hub: {scope} returned {resp.status_code}: {resp.text[:200]}")
        return resp.content

    async def _nova_list_devices(self, access_token: str):
        req = DevicesListRequest()
        req.deviceListRequestPayload.type = DeviceType.Value("SPOT_DEVICE")
        req.deviceListRequestPayload.id   = str(uuid.uuid4())
        raw = await self._nova_post(access_token, "nbe_list_devices", req.SerializeToString())
        dl  = DevicesList()
        dl.ParseFromString(raw)
        logger.debug("Google Find Hub: nbe_list_devices → %d device(s)", len(dl.deviceMetadata))
        return list(dl.deviceMetadata)

    async def _send_locate_action(
        self,
        access_token: str,
        canonic_id: str,
        fcm_token: str,
        request_uuid: str,
    ) -> None:
        req = ExecuteActionRequest()

        req.scope.type = DeviceType.Value("SPOT_DEVICE")
        req.scope.device.canonicId.id = canonic_id

        req.requestMetadata.type           = DeviceType.Value("SPOT_DEVICE")
        req.requestMetadata.requestUuid    = request_uuid
        req.requestMetadata.fmdClientUuid  = _FMDN_CLIENT_UUID
        req.requestMetadata.gcmRegistrationId.id = fcm_token
        req.requestMetadata.unknown        = True

        req.action.locateTracker.lastHighTrafficEnablingTime.seconds = int(datetime.now(timezone.utc).timestamp())
        req.action.locateTracker.contributorType = SpotContributorType.Value("FMDN_ALL_LOCATIONS")

        await self._nova_post(access_token, "nbe_execute_action", req.SerializeToString())
        logger.debug("Google Find Hub: locate-action sent for %s (uuid=%s)", canonic_id, request_uuid)

    async def _collect_device_update(
        self,
        username: str,
        access_token: str,
        canonic_id: str,
        fcm_token: str,
        req_uuid: str,
        future: asyncio.Future,
    ) -> tuple[str, object]:
        """Wait for one device's FCM response, retrying once on timeout."""
        loop  = asyncio.get_running_loop()
        key   = (username, req_uuid)
        device_update = None
        try:
            device_update = await asyncio.wait_for(asyncio.shield(future), timeout=30.0)
        except asyncio.TimeoutError:
            # Retry once — covers the brief FCM reconnect window (~100–200 ms).
            req_uuid2      = str(uuid.uuid4())
            future2        = loop.create_future()
            key2           = (username, req_uuid2)
            _pending[key2] = future2
            try:
                await self._send_locate_action(access_token, canonic_id, fcm_token, req_uuid2)
                device_update = await asyncio.wait_for(asyncio.shield(future2), timeout=20.0)
            except asyncio.TimeoutError:
                logger.warning("Google Find Hub: no location response for %s (tried twice)", canonic_id)
            except AuthExpiredError:
                raise
            except Exception as e:
                logger.warning("Google Find Hub: locate retry failed for %s: %s", canonic_id, e)
            finally:
                _pending.pop(key2, None)
        except AuthExpiredError:
            raise
        except Exception as e:
            logger.warning("Google Find Hub: location error for %s: %s", canonic_id, e)
        finally:
            _pending.pop(key, None)
        return canonic_id, device_update


# ── Module-level helpers ──────────────────────────────────────────────────────

def _canonic_ids(meta) -> list[str]:
    ident = meta.identifierInformation
    if ident.type == IDENTIFIER_ANDROID:
        return [c.id for c in ident.phoneInformation.canonicIds.canonicId if c.id]
    return [c.id for c in ident.canonicIds.canonicId if c.id]


def _decrypt_device_update(device_update, owner_key: Optional[bytes], canonic_id: str) -> Optional[dict]:
    """Decrypt location from a DeviceUpdate protobuf (FCM response)."""
    if owner_key is None:
        return None

    meta = device_update.deviceMetadata
    reg  = meta.information.deviceRegistration
    eus  = reg.encryptedUserSecrets
    enc_eik = eus.encryptedIdentityKey
    if not enc_eik:
        logger.error("Google Find Hub: no encryptedIdentityKey in DeviceUpdate for %s", canonic_id)
        return None

    # MCU trackers (custom ESP32/Zephyr) have their EIK stored with all bits flipped
    is_mcu = reg.fastPairModelId == _MCU_MODEL_ID
    logger.debug("Google Find Hub: EIK len=%d is_mcu=%s model=%r for %s", len(enc_eik), is_mcu, reg.fastPairModelId, canonic_id)
    if is_mcu:
        enc_eik = bytes(b ^ 0xFF for b in enc_eik)

    identity_key = _decrypt_eik(owner_key, enc_eik, canonic_id)
    if identity_key is None:
        logger.error("Google Find Hub: EIK decryption returned None for %s", canonic_id)
        return None

    reports = meta.information.locationInformation.reports.recentLocationAndNetworkLocations

    candidates: list[tuple] = []
    if reports.HasField("recentLocation"):
        candidates.append((reports.recentLocation, reports.recentLocationTimestamp))
    for loc, ts_msg in zip(reports.networkLocations, reports.networkLocationTimestamps):
        candidates.append((loc, ts_msg))

    logger.debug("Google Find Hub: %d candidate(s) for %s", len(candidates), canonic_id)
    if not candidates:
        logger.error("Google Find Hub: DeviceUpdate has no location reports for %s", canonic_id)
        return None

    best    = None
    best_ts = datetime.min.replace(tzinfo=timezone.utc)

    for i, (loc_report, ts_msg) in enumerate(candidates):
        ts = datetime.fromtimestamp(ts_msg.seconds, tz=timezone.utc) if ts_msg.seconds else None
        has_geo = loc_report.HasField("geoLocation")
        logger.debug(
            "Google Find Hub: candidate[%d] ts_sec=%s has_geo=%s for %s",
            i, ts_msg.seconds, has_geo, canonic_id,
        )
        if ts is None:
            logger.error("Google Find Hub: candidate[%d] has ts_seconds=0, skipping for %s", i, canonic_id)
            continue

        if not has_geo:
            sem_name = loc_report.semanticLocation.locationName if loc_report.HasField("semanticLocation") else "none"
            logger.error("Google Find Hub: candidate[%d] has no geoLocation (semanticLocation=%r), skipping for %s", i, sem_name, canonic_id)
            continue

        geo      = loc_report.geoLocation
        enc      = geo.encryptedReport
        accuracy = float(geo.accuracy) if geo.accuracy else None
        logger.info(
            "Google Find Hub: candidate[%d] raw geoLocation hex: %s for %s",
            i, geo.SerializeToString().hex(), canonic_id,
        )

        time_offset = 0 if is_mcu else geo.deviceTimeOffset
        plaintext = _decrypt_report(enc, identity_key, canonic_id, time_offset, ts_msg.seconds)
        if plaintext is None:
            continue

        loc_proto = Location()
        try:
            loc_proto.ParseFromString(plaintext)
        except Exception as e:
            logger.error("Google Find Hub: Location proto parse failed for %s: %s", canonic_id, e)
            continue

        lat = loc_proto.latitude  / 1e7
        lng = loc_proto.longitude / 1e7
        logger.debug("Google Find Hub: candidate[%d] decrypted lat=%.6f lng=%.6f for %s", i, lat, lng, canonic_id)
        if lat == 0.0 and lng == 0.0:
            logger.error("Google Find Hub: candidate[%d] decrypted to 0,0 — skipping for %s", i, canonic_id)
            continue

        source    = "find_hub_own" if enc.isOwnReport else "find_hub_network"
        candidate = {
            "latitude":  lat,
            "longitude": lng,
            "altitude":  loc_proto.altitude if loc_proto.altitude else None,
            "accuracy":  accuracy,
            "timestamp": ts,
            "source":    source,
        }
        if ts > best_ts:
            best_ts = ts
            best    = candidate

    if best is None:
        logger.error("Google Find Hub: all %d candidate(s) failed for %s", len(candidates), canonic_id)
    return best


def _decrypt_eik(owner_key: bytes, encrypted_eik: bytes, canonic_id: str) -> Optional[bytes]:
    """Decrypt the per-device Ephemeral Identity Key (EIK) using the account owner_key."""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.backends import default_backend

        if len(encrypted_eik) == 48:
            iv, ct = encrypted_eik[:16], encrypted_eik[16:]
            dec = Cipher(algorithms.AES(owner_key), modes.CBC(iv), backend=default_backend()).decryptor()
            return dec.update(ct) + dec.finalize()
        if len(encrypted_eik) == 60:
            iv, ct = encrypted_eik[:12], encrypted_eik[12:]
            return AESGCM(owner_key).decrypt(iv, ct, None)
        logger.debug("Google Find Hub: unexpected EIK length %d for %s", len(encrypted_eik), canonic_id)
        return None
    except Exception as e:
        logger.error("Google Find Hub: EIK decryption failed for %s: %s", canonic_id, e)
        return None


def _decrypt_report(enc, identity_key: bytes, canonic_id: str, device_time_offset: int, report_ts: int = 0) -> Optional[bytes]:
    """Decrypt a single EncryptedReport."""
    if not enc.encryptedLocation:
        logger.error(
            "Google Find Hub: encryptedLocation empty — raw EncryptedReport hex: %s (isOwnReport=%s publicKeyRandom=%s) for %s",
            enc.SerializeToString().hex(),
            enc.isOwnReport,
            enc.publicKeyRandom.hex() if enc.publicKeyRandom else "empty",
            canonic_id,
        )
        return None

    if enc.isOwnReport or enc.publicKeyRandom == b"":
        try:
            return _decrypt_own_report(identity_key, enc.encryptedLocation)
        except Exception as e:
            logger.error("Google Find Hub: own report decryption failed for %s: %s", canonic_id, e)
            return None

    # Network report: deviceTimeOffset is a uint32 that defaults to 0 when unset.
    # When 0, fall back to the report timestamp, and also try ±1 adjacent 1024-second
    # buckets to handle clock drift at bucket boundaries.
    K = 10
    bucket = 1 << K  # 1024 s
    offsets: list[int] = [device_time_offset]
    if report_ts and report_ts != device_time_offset:
        offsets += [report_ts, report_ts - bucket, report_ts + bucket]
    if device_time_offset:
        offsets += [device_time_offset - bucket, device_time_offset + bucket]

    seen: set[int] = set()
    last_err: Optional[Exception] = None
    for ts in offsets:
        if ts in seen:
            continue
        seen.add(ts)
        try:
            return _decrypt_network_report(identity_key, enc.encryptedLocation, enc.publicKeyRandom, ts)
        except Exception as e:
            last_err = e

    logger.error(
        "Google Find Hub: network report decryption failed for %s (tried %d time offsets): %s",
        canonic_id, len(seen), last_err,
    )
    return None


def _decrypt_own_report(identity_key: bytes, encrypted_location: bytes) -> bytes:
    """Own report: AES-GCM with key = SHA-256(identity_key)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = hashlib.sha256(identity_key).digest()
    return AESGCM(key).decrypt(encrypted_location[:12], encrypted_location[12:], None)


def _decrypt_network_report(
    identity_key: bytes,
    encrypted_location: bytes,
    public_key_random: bytes,
    device_time_offset: int,
) -> bytes:
    """
    Crowd-sourced report: FMDN ECDH decryption on SECP160r1 + AES-EAX.

    r     = AES-ECB-256(identity_key, fmdn_data(masked_ts)) mod n
    R     = r * G
    S.x   = public_key_random (20 bytes), S.y recovered from curve
    k     = HKDF-SHA256((r*S).x, salt=None, info=b'')
    nonce = R.x[-8:] || S.x[-8:]
    plain = AES-EAX-256-DEC(k, nonce, m', tag)
    """
    from ecdsa import SECP160r1
    from ecdsa.ellipticcurve import Point
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives import hashes
    from Cryptodome.Cipher import AES

    curve = SECP160r1
    K     = 10
    ts_b  = (device_time_offset & (~((1 << K) - 1) & 0xFFFFFFFF)).to_bytes(4, "big")

    buf = bytearray(32)
    buf[0:11]  = b"\xff" * 11
    buf[11]    = K
    buf[12:16] = ts_b
    buf[16:27] = b"\x00" * 11
    buf[27]    = K
    buf[28:32] = ts_b

    r_int = int.from_bytes(AES.new(identity_key, AES.MODE_ECB).encrypt(bytes(buf)), "big") % curve.order
    R     = r_int * curve.generator

    Sx = int.from_bytes(public_key_random, "big")
    p  = curve.curve.p()
    yy = (Sx**3 + curve.curve.a() * Sx + curve.curve.b()) % p
    y0 = pow(yy, (p + 1) // 4, p)

    # The broadcast x-coordinate has two valid y values; try both since the parity
    # bit is not transmitted in the FMDN advertisement.
    last_err: Optional[Exception] = None
    for y in (y0, p - y0):
        try:
            S     = Point(curve.curve, Sx, y)
            k     = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"").derive(
                (r_int * S).x().to_bytes(20, "big")
            )
            nonce = R.x().to_bytes(20, "big")[12:] + S.x().to_bytes(20, "big")[12:]
            return AES.new(k, AES.MODE_EAX, nonce=nonce).decrypt_and_verify(
                encrypted_location[:-16], encrypted_location[-16:]
            )
        except Exception as e:
            last_err = e
    raise last_err or ValueError("both y parities failed")
