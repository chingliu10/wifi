BEGIN;

UPDATE sites
SET
  external_portal_site_id = COALESCE(
    external_portal_site_id,
    '6abea43ebd880b52d6a7094c'
  ),
  updated_at = NOW()
WHERE slug = 'small-garden';

UPDATE network_devices
SET
  site_id = (SELECT id FROM sites WHERE slug = 'small-garden' LIMIT 1),
  name = 'Small Garden EAP225 Outdoor',
  nas_identifier = 'small-garden-eap225',
  brand = 'TP-Link Omada',
  model = 'EAP225-Outdoor',
  management_ip = '192.168.1.2',
  ap_mac = '10:5A:95:51:F0:C4',
  device_type = 'omada',
  active = TRUE,
  updated_at = NOW()
WHERE ap_mac = '10:5A:95:51:F0:C4';

INSERT INTO network_devices (
  site_id,
  name,
  nas_identifier,
  brand,
  model,
  management_ip,
  ap_mac,
  device_type,
  active
)
SELECT
  s.id,
  'Small Garden EAP225 Outdoor',
  'small-garden-eap225',
  'TP-Link Omada',
  'EAP225-Outdoor',
  '192.168.1.2',
  '10:5A:95:51:F0:C4',
  'omada',
  TRUE
FROM sites s
WHERE s.slug = 'small-garden'
  AND NOT EXISTS (
    SELECT 1
    FROM network_devices nd
    WHERE nd.ap_mac = '10:5A:95:51:F0:C4'
  );

COMMIT;
