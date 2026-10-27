// ─────────────────────────────────────────────────────────────────────────────
// Where the connector is downloaded from.
//
// The file is ninety megabytes — it carries its own runtime so that a customer
// installs nothing else — which is no way to treat a git repository. So it is
// published wherever the deployment keeps large files and named here by its
// address, and the portal shows the download only once that address is set.
// An absent setting hides the button rather than offering a broken link.
// ─────────────────────────────────────────────────────────────────────────────

export const CONNECTOR_DOWNLOAD_URL = process.env.NEXT_PUBLIC_CONNECTOR_URL?.trim() || null;

/** What the file is called once it reaches the customer's Downloads folder. */
export const CONNECTOR_FILE_NAME = 'rekonza-tally.exe';
