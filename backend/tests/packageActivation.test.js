import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI ||= 'mongodb://localhost:27017/rabsdata-test';
process.env.JWT_SECRET ||= 'test-secret';

const [
  { default: DataPackage },
  { default: PackageActivationAudit },
  { updatePackage, updatePackageActivation },
  { isEligiblePadodaPackage },
] = await Promise.all([
  import('../models/DataPackage.js'),
  import('../models/PackageActivationAudit.js'),
  import('../controllers/adminController.js'),
  import('../services/supplierCatalogService.js'),
]);

const makePackage = (isActive = true) => ({
  _id: '64d9e76af742f8ab3f1e29d1',
  network: 'MTN',
  name: 'MTN 1GB',
  dataAmount: '1GB',
  validity: 'Non-expiry',
  bundleType: 'standard',
  restrictions: [],
  providerCost: 4,
  sellingPrice: 10,
  providerPackageCode: 'mtn-1gb',
  volumeInMB: 1024,
  isActive,
  supplierOffers: { padodatagh: {
    packageCode: 'mtn-1gb',
    supplierCost: 4,
    network: 'MTN',
    volumeInMB: 1024,
    validity: 'Non-expiry',
    bundleType: 'standard',
    restrictions: [],
    hasUnstructuredConditions: false,
    hasValidityConflict: false,
    catalogVerified: true,
    lastVerifiedAt: new Date(),
  } },
  saves: 0,
  async save() { this.saves += 1; },
});

const invoke = async (controller, body, dataPackage) => {
  let response;
  let caught;
  await controller(
    { params: { id: String(dataPackage._id) }, body, user: { _id: 'admin-user-id' } },
    { json(value) { response = value; return value; } },
    (error) => { caught = error; }
  );
  if (caught) throw caught;
  return response;
};

test('price-only package update preserves active status and PadodaTagh eligibility without audit noise', async () => {
  const originalFind = DataPackage.findById;
  const originalAuditCreate = PackageActivationAudit.create;
  const dataPackage = makePackage(true);
  const auditRecords = [];
  DataPackage.findById = async () => dataPackage;
  PackageActivationAudit.create = async (event) => { auditRecords.push(event); return event; };

  try {
    const response = await invoke(updatePackage, { providerCost: 4, sellingPrice: 12 }, dataPackage);
    assert.equal(response.package.sellingPrice, 12);
    assert.equal(response.package.isActive, true);
    assert.equal(isEligiblePadodaPackage(response.package), true);
    assert.equal(auditRecords.length, 0);
  } finally {
    DataPackage.findById = originalFind;
    PackageActivationAudit.create = originalAuditCreate;
  }
});

test('stale edit payload containing activation is rejected without changing status or price', async () => {
  const originalFind = DataPackage.findById;
  const originalAuditCreate = PackageActivationAudit.create;
  const dataPackage = makePackage(true);
  let auditWrites = 0;
  DataPackage.findById = async () => dataPackage;
  PackageActivationAudit.create = async () => { auditWrites += 1; };

  try {
    await assert.rejects(
      invoke(updatePackage, { sellingPrice: 12, isActive: false }, dataPackage),
      { code: 'ACTIVATION_REQUIRES_EXPLICIT_ACTION' }
    );
    assert.equal(dataPackage.isActive, true);
    assert.equal(dataPackage.sellingPrice, 10);
    assert.equal(dataPackage.saves, 0);
    assert.equal(auditWrites, 0);
  } finally {
    DataPackage.findById = originalFind;
    PackageActivationAudit.create = originalAuditCreate;
  }
});

test('explicit activation and deactivation update state and append actor/source audit records', async () => {
  const originalFind = DataPackage.findById;
  const originalAuditCreate = PackageActivationAudit.create;
  const dataPackage = makePackage(false);
  const auditRecords = [];
  DataPackage.findById = async () => dataPackage;
  PackageActivationAudit.create = async (event) => { auditRecords.push(event); return event; };

  try {
    await invoke(updatePackageActivation, { isActive: true }, dataPackage);
    assert.equal(dataPackage.isActive, true);
    assert.equal(isEligiblePadodaPackage(dataPackage), true);
    await invoke(updatePackageActivation, { isActive: false }, dataPackage);
    assert.equal(dataPackage.isActive, false);
    assert.equal(isEligiblePadodaPackage(dataPackage), true);
    assert.deepEqual(auditRecords.map(({ previousActive, newActive, sourceOperation, actor }) => ({
      previousActive, newActive, sourceOperation, actor,
    })), [
      { previousActive: false, newActive: true, sourceOperation: 'admin_package_activation', actor: 'admin-user-id' },
      { previousActive: true, newActive: false, sourceOperation: 'admin_package_activation', actor: 'admin-user-id' },
    ]);
    assert.ok(auditRecords.every((event) => event.changedAt instanceof Date));
  } finally {
    DataPackage.findById = originalFind;
    PackageActivationAudit.create = originalAuditCreate;
  }
});

test('activating a package does not bypass stale supplier verification', async () => {
  const originalFind = DataPackage.findById;
  const originalAuditCreate = PackageActivationAudit.create;
  const stalePackage = makePackage(false);
  stalePackage.supplierOffers.padodatagh.lastVerifiedAt = new Date(Date.now() - 31 * 60 * 1000);
  DataPackage.findById = async () => stalePackage;
  PackageActivationAudit.create = async (event) => event;

  try {
    await invoke(updatePackageActivation, { isActive: true }, stalePackage);
    assert.equal(stalePackage.isActive, true);
    assert.equal(isEligiblePadodaPackage(stalePackage), false);
  } finally {
    DataPackage.findById = originalFind;
    PackageActivationAudit.create = originalAuditCreate;
  }
});
