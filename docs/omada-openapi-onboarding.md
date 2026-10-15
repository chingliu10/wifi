# Omada Open API onboarding design

## Goal

Solidus WiFi should own the onboarding flow. A client should not need access to the central Omada Controller.

## Controller integration

Create a Client Credentials Open API app in:

Global View -> Settings -> Platform Integration -> Open API

Required capabilities for the current onboarding flow:

- Global Dashboard Manager Modify — create Omada sites
- Site Device Manager View Only — read pending/managed devices
- Site Adopt Device Manager Access — start adoption and read adoption result

The controller credentials belong only in the VPS environment.

## Verified Open API flow

Authentication:

```
POST /openapi/authorize/token?grant_type=client_credentials
{
  "omadacId": "...",
  "client_id": "...",
  "client_secret": "..."
}
```

Authenticated calls use:

```
Authorization: AccessToken=<token>
```

Site creation:

```
POST /openapi/v1/{omadacId}/sites
```

Required fields are:

- name
- region
- timeZone
- scenario
- deviceAccountSetting.username
- deviceAccountSetting.password

The device account password must be 10–64 characters and include uppercase, lowercase, number and supported special characters.

Pending devices:

```
GET /openapi/v1/{omadacId}/sites/{siteId}/grid/devices/pending?page=1&pageSize=100
```

Start adoption:

```
POST /openapi/v1/{omadacId}/sites/{siteId}/devices/{deviceMac}/start-adopt
{
  "username": "...",
  "password": "..."
}
```

Read asynchronous adoption result:

```
GET /openapi/v1/{omadacId}/sites/{siteId}/devices/{deviceMac}/adopt-result
```

Important adopt result codes:

- 0 — success
- -39002 — device did not respond
- -39003 — device username/password incorrect
- -39004 — adoption failed
- -39005 — device not connected
- -39329 — uplink AP link failure

Managed devices:

```
GET /openapi/v1/{omadacId}/sites/{siteId}/devices?page=1&pageSize=100
```

## Solidus onboarding model

1. Client creates a site in Solidus.
2. Solidus creates the corresponding Omada site via Open API.
3. Solidus generates a unique Omada device account for that site and stores the password encrypted with AES-256-GCM.
4. Client factory-resets the EAP.
5. During the EAP first-run wizard, client uses the device account displayed by Solidus.
6. Client enters the Solidus Omada controller host in Controller Inform URL.
7. Client claims the AP in Solidus by entering/scanning the AP MAC from its label.
8. A background worker watches only that claimed MAC.
9. When the AP appears Pending, Solidus calls start-adopt for the correct Omada site.
10. Solidus polls adoption result and the managed-device list.
11. When connected, Solidus records the AP under the correct tenant/site.
12. Next phase: Solidus pushes WLAN, external portal and RADIUS configuration through Omada APIs.

The AP MAC claim is deliberate. A self-hosted Omada Software Controller receives pending devices centrally, so Solidus needs an unambiguous way to associate a remote factory AP with the correct SaaS tenant before automatic adoption.

## Security

- Never expose OMADA_CLIENT_SECRET in the browser or database.
- Never log access tokens.
- Per-site device credentials are encrypted at rest.
- Existing local EAP credentials supplied during a recovery onboarding are encrypted temporarily and deleted after successful adoption.
- Open API permissions should be reduced to the minimum required once the integration is validated.
