-- The operator CLI links to a workspace with the same one-time pairing codes as the
-- Android companion. CLI sessions carry the cli:operator scope instead of mobile scopes.
ALTER TABLE mobile_devices DROP CONSTRAINT mobile_devices_platform_check;
ALTER TABLE mobile_devices
  ADD CONSTRAINT mobile_devices_platform_check CHECK (platform IN ('android','cli'));
