# Millwater PMS AMI 2.0 integration

Millwater PMS reads live meter and feeder data from the AMI head-end through its own read-only server proxy (`backend/server/ami.js`). The browser never sees the AMI token.

## Setting up the connection

An administrator opens **Settings → AMI connection** and enters:

- **AMI address** — the head-end origin with no path. The partner documentation currently uses `http://eel.ecuas.com.cn:1080`.
- **API token** — issued by the AMI vendor. It is encrypted with `SETTINGS_ENCRYPTION_KEY` before it is stored and cannot be viewed again; it can be replaced or removed.
- **Allow unencrypted HTTP** — required only when the address is `http://`. Over HTTP the token and readings travel unencrypted, so use it only on a trusted private network or VPN.

**Test connection** checks that the head-end answers with the saved details. All changes and tests are recorded in the audit log, with the token masked.

`AMI_API_BASE_URL`, `AMI_API_TOKEN` and `AMI_ALLOW_INSECURE_HTTP` environment variables still work as a fallback when nothing has been saved in Settings.

## Who can use it

The live readings panel on **Feeder & Meters** is available to System Administrators and Network Operations. Access follows the user's Millwater PMS login and role; there is no separate access key.

## Supported readings

Millwater PMS can list `AMMETER` and `SENSOR_FCM` devices and display the selected device's latest raw data items. Feeder monitor topology names are not automatically mapped to Millwater PMS feeder IDs. AMI data items do not guarantee units or register semantics, so raw values are not automatically applied to Millwater PMS telemetry or invoices. Confirm the deployed meter profile, cumulative-register meaning, multiplier, and topology mapping before wiring readings into billing calculations.
