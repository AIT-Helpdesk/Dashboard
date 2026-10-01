// One-time data-sync script for product_mappings -- run this once on
// production after deploying, to bring that environment's own data.db (a
// real, live, per-environment database -- see .gitignore's own comment on
// it, same reasoning as every other real data.db on this dashboard) up to
// the exact same ms_sku_id/friendly-name/row state this one was hand-
// edited to reach this session, entirely via a chat conversation (Check
// Client's M365 Tenancy matching against real Microsoft Graph subscribed-
// SKU data). Nothing here is guessable from the PRODUCT_MAPPINGS seed
// array in db.js -- every value below is real data Amber supplied.
//
// Usage (from the server, same shape as every other one-off script this
// dashboard runs directly with node):
//
//   cd C:\apps\autotask-dashboard-git\packages\contract-checks
//   node apply-product-mapping-sku-updates.js
//
// Safe to run more than once -- every step below is idempotent:
//   - UPDATEs are keyed on ingram_product_name (the table's own UNIQUE
//     column), so re-running one just writes the same value again.
//   - The DELETE targets the exact OLD compound ms_sku_part_number value
//     (see below) -- a no-op once that row's already gone.
//   - The 5 new rows use INSERT OR IGNORE, so a second run skips them
//     rather than failing on the UNIQUE constraint.
//
// Does NOT run automatically on server start (unlike db.js's own
// migrateAddMsSkuId(), which only adds the empty COLUMN) -- this fills in
// real per-row DATA, which only ever needs to happen once per environment,
// not on every single process start the way a schema migration does.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'data.db'));
const now = new Date().toISOString();

// [ingram_product_name, ms_sku_id] -- every pre-existing seeded row that
// just needed its real Microsoft SKU GUID filled in.
const SKU_ID_UPDATES = [
  ['Clipchamp Premium', '0fe440c5-f2bf-442b-a4f4-9a7af77a200b'],
  ['Dynamics 365 Sales Enterprise Edition (Non-Profit Pricing)', '1e1a282c-9c54-43a2-9310-98ef728faace'],
  ['Exchange Online (Plan 1)', '4b9405b0-7788-4568-add1-99614e613b69'],
  ['Exchange Online (Plan 2)', '19ec0d23-8335-4cbd-94ac-6050e30712fa'],
  ['Exchange Online Archiving for Exchange Online', 'ee02fd1b-340e-4a4b-b355-4a514e4c8943'],
  ['Microsoft 365 Apps for business', 'cdd28e44-67e3-425e-be4c-737fab2899d3'],
  ['Microsoft 365 Apps for enterprise', 'c2273bd0-dff7-4215-9ef5-2c7bcfb06425'],
  ['Microsoft 365 Business Basic', '3b555118-da6a-4418-894f-7df1e2096870'],
  ['Microsoft 365 Business Basic Donation (Non-Profit Pricing)', '3b555118-da6a-4418-894f-7df1e2096870'],
  ['Microsoft 365 Business Premium', 'cbdc14ab-d96c-4c30-b9f4-6ada7cdc1d46'],
  ['Microsoft 365 Business Premium (no Teams)', '00e1ec7b-e4a3-40d1-9441-b69b597ab222'],
  ['Microsoft 365 Business Premium (Nonprofit Staff Pricing)', 'cbdc14ab-d96c-4c30-b9f4-6ada7cdc1d46'],
  ['Microsoft 365 Business Premium with Copilot', 'a6d18b68-a67e-4cbd-ba00-8744bc468faa'],
  ['Microsoft 365 Business Standard', 'f245ecc8-75af-4f8e-b61f-27d8114de5f3'],
  ['Microsoft 365 Business Standard (no Teams) Trial', 'f245ecc8-75af-4f8e-b61f-27d8114de5f3'],
  ['Microsoft 365 Business Standard (no Teams)', '5a1c7b8d-0739-4ca8-bf69-ec87e69133ac'],
  ['Microsoft 365 Business Standard (Non-Profit Pricing)', 'f245ecc8-75af-4f8e-b61f-27d8114de5f3'],
  ['Microsoft 365 Copilot', '639dec6b-bb19-468b-871c-c5c441c4b0cb'],
  ['Microsoft 365 Copilot Business', 'a69133fb-7e57-40ce-9a69-6c8551bb7854'],
  ['Microsoft 365 F3', '66b55226-6b4f-492c-910c-a3b7a3c9d993'],
  ['Microsoft Defender for Business', '5e1e7702-a2b7-4360-8d07-2f515792896f'],
  ['Microsoft Defender for Office 365 (Plan 1)', '4ef96642-f096-40de-a3e9-d83fb2f90211'],
  ['Microsoft Defender for Office 365 (Plan 1) (Non-Profit Pricing)', '4ef96642-f096-40de-a3e9-d83fb2f90211'],
  ['Microsoft Entra ID P1', '078d2b04-f1bd-4111-bbd4-b4b1b354cef4'],
  ['Microsoft Entra ID P2', '84a661c4-e949-4bd2-a560-ed7766fcaf2b'],
  ['Microsoft Teams Phone Standard', 'e43b5b99-8dfb-405f-9987-dc307f34bcbd'],
  ['Office 365 E3', '6fd2c87f-b296-42f0-b197-1e91e994b900'],
  ['Office 365 Extra File Storage', '99049c9c-6011-4908-bf17-15f496e6519d'],
  ['Office 365 F3', '4b585984-651b-448a-9e53-3b10f069cf7f'],
  ['Planner and Project Plan 3', '53818b1b-4a27-454b-8896-0dba576410e6'],
  ['Planner and Project Plan 5', '46102f44-d912-47e7-b0ca-1bd7b70ada3b'],
  ['Power BI Pro', 'f8a1db68-be16-40ed-86d5-cb42ce701560'],
  ['Power BI Pro (Non-Profit Pricing)', '420af87e-8177-4146-a780-3786adaffbca'],
  ['Visio Plan 1', '4b244418-9658-4451-a2b8-b5e2b364e9bd'],
  ['Visio Plan 2', '38b434d2-a15e-4cde-9a98-e737c75623e1'],
  ['Windows 10/11 Enterprise E3', '6a0f6da5-0b87-4190-a6ae-9bb5a2b9546a'],
  ['Windows 365 Business 2 vCPU, 8 GB, 128 GB', '71f21848-f89b-4aaa-a2dc-780c8e8aac5b'],
  ['Windows 365 Business 2 vCPU, 8 GB, 256 GB', '750d9542-a2f8-41c7-8c81-311352173432'],
  ['Windows 365 Enterprise 2 vCPU, 4 GB, 128 GB', '226ca751-f0a4-4232-9be5-73c02a92555e'],
  ['Windows 365 Enterprise 2 vCPU, 8 GB, 128 GB', 'e2aebe6c-897d-480f-9d62-fff1381581f7'],
  ['Windows 365 Enterprise 2 vCPU, 8 GB, 256 GB', '1c79494f-e170-431f-a409-428f6053fa35'],
  ['OneDrive for business (Plan 2)', 'ed01faf2-1d88-4947-ae91-45ca18703a96'],
  ['NO INGRAM CODE:POWERAPPS_DEV', '5b631642-bd26-49fe-bd20-1daaa972ef80'],
  ['NO INGRAM CODE:FLOW_FREE', 'f30db892-07e9-47e9-837c-80727f46fd3d'],
  ['NO INGRAM CODE:POWER_BI_STANDARD', 'a403ebcc-fae0-4ca2-8c8c-7a907fd6c235'],
  ['NO INGRAM CODE:Power_Pages_vTrial_for_Makers', '3f9f06f5-3c31-472c-985f-62d9c10ec167'],
  ['NO INGRAM CODE:RIGHTSMANAGEMENT_ADHOC', '8c4ce438-32a7-4ac5-91a6-e22ae08d9c8b'],
  ['NO INGRAM CODE:NONPROFIT_PORTAL', 'aa2695c9-8d59-4800-9dc8-12e01f1735af'],
  ['NO INGRAM CODE:Dynamics_365_Sales_Premium_Viral_Trial', '6ec92958-3cc1-49db-95bd-bc6b3798df71'],
  ['NO INGRAM CODE:DYN365_BUSINESS_MARKETING', '238e2f8d-e429-4035-94db-6926be4ffe7b'],
  ['NO INGRAM CODE:WINDOWS_STORE', '6470687e-a428-4b7a-bef2-8a291ad947c9'],
  ['NO INGRAM CODE:FORMS_PRO', 'bc946dac-7877-4271-b2f7-99d2db13cd2c'],
  ['NO INGRAM CODE:Microsoft_Teams_Exploratory_Dept', 'e0dfc8b9-9531-4ec8-94b4-9fec23b05fc8'],
  ['NO INGRAM CODE:PROJECTPREMIUM', '09015f9f-377f-4538-bbb5-f75ceb09358a'],
];

// FORMS_PRO's own friendly_ms_product_name was NULL in the original seed
// data (a "NO INGRAM CODE:" row with no friendly name supplied) -- filled
// in alongside its ms_sku_id.
const FORMS_PRO_FRIENDLY_NAME = 'Dynamics 365 Customer Voice Trial';

// The exact OLD compound ms_sku_part_number value this session's "split
// into two real rows" edit replaced -- see the two INSERT rows below for
// what replaced it. Matched on this exact string (not ingram_product_name,
// which the NEW first row below reuses) so this DELETE can never touch
// either of the two new rows on a second run.
const OLD_COMPOUND_SKU = 'BUSINESS_STANDARD_AND_COPILOT_FOR_BUSINESS/MICROSOFT_365_COPILOT_BUSINESS_DEPT';

// [ingram_product_name, ms_sku_part_number, ms_sku_id, friendly_ms_product_name, free]
// -- 3 brand-new SKUs (never in the original PRODUCT_MAPPINGS seed array at
// all) plus the 2 rows that replaced the one old compound row above.
const NEW_ROWS = [
  ['NO INGRAM CODE:RMSBASIC', 'RMSBASIC', '093e8d14-a334-43d9-93e3-30589a8b47d0', 'Rights Management Service Basic Content Protection', null],
  ['NO INGRAM CODE:Microsoft_Teams_Rooms_Basic', 'Microsoft_Teams_Rooms_Basic', '6af4b3d6-14bb-4a2a-960c-6c902aad34f3', 'Microsoft Teams Rooms Basic', null],
  ['NO INGRAM CODE:PROJECT_MADEIRA_PREVIEW_IW_SKU', 'PROJECT_MADEIRA_PREVIEW_IW_SKU', '6a4a1628-9b9a-424d-bed5-4118f0ede3fd', 'Dynamics 365 Business Central for IWs', null],
  ['Microsoft 365 Business Standard with Copilot', 'MICROSOFT_365_COPILOT_BUSINESS_DEPT', '27d147f4-62a0-46cc-a043-a70bb9759b7e', 'Microsoft 365 copilot business dept', 0],
  ['Microsoft 365 Business Standard and Microsoft 365 Copilot Business', 'BUSINESS_STANDARD_AND_COPILOT_FOR_BUSINESS', 'f1e78181-93b9-4981-96b8-adc273c746fc', 'Microsoft 365 Business Standard with Copilot', 0],
];

let updated = 0;
let notFound = [];
const updateStmt = db.prepare(`UPDATE product_mappings SET ms_sku_id = ?, updated_at = ? WHERE ingram_product_name = ?`);
for (const [ingramName, skuId] of SKU_ID_UPDATES) {
  const result = updateStmt.run(skuId, now, ingramName);
  if (result.changes === 0) notFound.push(ingramName);
  updated += result.changes;
}

const formsProResult = db
  .prepare(`UPDATE product_mappings SET friendly_ms_product_name = ?, updated_at = ? WHERE ingram_product_name = 'NO INGRAM CODE:FORMS_PRO'`)
  .run(FORMS_PRO_FRIENDLY_NAME, now);

const deleteResult = db.prepare(`DELETE FROM product_mappings WHERE ms_sku_part_number = ?`).run(OLD_COMPOUND_SKU);

const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO product_mappings (ingram_product_name, ms_sku_part_number, ms_sku_id, friendly_ms_product_name, free, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
let inserted = 0;
for (const [ingramName, sku, skuId, friendlyName, free] of NEW_ROWS) {
  const result = insertStmt.run(ingramName, sku, skuId, friendlyName, free, now, now);
  inserted += result.changes;
}

console.log(`ms_sku_id set/refreshed on ${updated}/${SKU_ID_UPDATES.length} rows.`);
if (notFound.length > 0) {
  console.log('WARNING -- no row found for these ingram_product_name values (nothing updated for them):', notFound);
}
console.log('FORMS_PRO friendly name updated:', formsProResult.changes);
console.log('Old compound Copilot row deleted:', deleteResult.changes);
console.log(`New rows inserted: ${inserted}/${NEW_ROWS.length} (0 on a second run is expected -- already there).`);

db.close();
