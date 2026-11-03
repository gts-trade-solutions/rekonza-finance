-- A customer's or vendor's registration, as the GST system and the Ministry of
-- Corporate Affairs record it, filled in from the GSTIN and the CIN
-- (lib/server/integrations/party-lookup.ts): the kind of business, whether the
-- GST registration is active and since when, the company's CIN and the date
-- it was incorporated. The PAN already has its column.
ALTER TABLE contacts
  ADD COLUMN constitution      VARCHAR(60) NULL,
  ADD COLUMN gst_status        VARCHAR(30) NULL,
  ADD COLUMN gst_registered_on DATE        NULL,
  ADD COLUMN cin               VARCHAR(21) NULL,
  ADD COLUMN incorporated_on   DATE        NULL;
