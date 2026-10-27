-- 009_gst_treatment_alignment.sql
-- The initial enum used GST's own vocabulary; the application uses a slightly
-- different spelling for two of the same values ('registered_composition' for a
-- composition dealer, 'consumer' for an unregistered individual as distinct
-- from an unregistered business).
--
-- Widening rather than renaming. The full list below is the set GST actually
-- recognises, and every value the application can produce is in it. Which
-- treatment a contact carries decides whether tax is charged, who pays it, and
-- which GSTR-1 table the supply is reported in, so an unmappable value here is
-- a filing error rather than a display problem.

ALTER TABLE contacts
  MODIFY COLUMN gst_treatment ENUM(
    'registered',              -- registered business, regular scheme
    'registered_composition',  -- registered business, composition scheme
    'unregistered',            -- unregistered business
    'consumer',                -- individual, not registered
    'overseas',                -- export or import
    'sez',                     -- special economic zone unit
    'sez_developer',
    'deemed_export',
    'uin'                      -- embassies and UN bodies
  ) NOT NULL DEFAULT 'unregistered';
