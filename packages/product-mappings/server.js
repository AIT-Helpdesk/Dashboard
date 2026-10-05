const express = require('express');
const {
  listProductMappings,
  getProductMappingColumns,
  createProductMapping,
  updateProductMapping,
  deleteProductMapping,
} = require('@dashboard/contract-checks/db.js');
const { isContractManager } = require('@dashboard/shell/contract-manager-permissions.js');

// View/edit UI for @dashboard/contract-checks' own product_mappings table
// (its db.js is the real source of truth -- this page just gives it a
// front end), by request ("I'd like to be able to view and edit the
// product_mapping table"). Reads are open to anyone who can reach this
// page; writes (create/update/delete) are gated to a Contract Manager
// (same @dashboard/shell/contract-manager-permissions.js list Check
// Client's own "adjust contract units" feature already uses) -- this
// table feeds real matching logic elsewhere (Contract Checks/Check
// Client), so an edit here has real downstream effect, same reasoning
// that feature's own gate documents. Every write route double-checks
// this server-side regardless of what the client's own UI shows/hides --
// never trust a hidden button alone.
const router = express.Router();
router.use(express.json());

// columns -- the table's own real structure (name/label/required/unique/
// inputType), by request ("generate the columns and edit page based on
// the table structure on the fly instead of hard coded") -- client.js
// builds both the list view's columns and the add/edit form's fields
// from this, so a column added to product_mappings later needs no
// change here or there.
router.get('/', (req, res) => {
  res.json({ mappings: listProductMappings(), columns: getProductMappingColumns(), isManager: isContractManager(req) });
});

router.post('/', (req, res) => {
  if (!isContractManager(req)) {
    return res.status(403).json({ error: 'Only a Contract Manager can add product mappings.' });
  }
  try {
    const mapping = createProductMapping(req.body || {});
    res.json({ mapping });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  if (!isContractManager(req)) {
    return res.status(403).json({ error: 'Only a Contract Manager can edit product mappings.' });
  }
  try {
    const mapping = updateProductMapping(Number(req.params.id), req.body || {});
    res.json({ mapping });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  if (!isContractManager(req)) {
    return res.status(403).json({ error: 'Only a Contract Manager can delete product mappings.' });
  }
  try {
    deleteProductMapping(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
