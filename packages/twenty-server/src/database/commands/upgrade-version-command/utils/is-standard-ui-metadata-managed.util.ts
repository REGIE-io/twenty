// REGIE tenants consume Twenty as a CRM API and never render Twenty's own UI, so
// provisioning does not create the standard UI metadata — see
// TWENTY_STANDARD_UI_METADATA_NAME in
// src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-all-metadata-name.constant.ts
//
// Upstream upgrade commands whose only job is reshaping that UI metadata are
// therefore no-ops here. Running them fails, because they assume standard views,
// page layouts and their field metadata already exist — and because the instance
// commands adding new widget-type enum values live in already-passed version
// directories, so they never execute on an existing database.
//
// Typed as boolean (not the literal false) so the guarded code below each check
// does not read as unreachable. Flip this to true if Twenty's own UI is ever
// served to tenants; every guarded command becomes active again.
export const IS_STANDARD_UI_METADATA_MANAGED: boolean = false;
