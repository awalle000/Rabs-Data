export const getSupplierFailureUpdates = (error) => ({
  supplierSubmitted: false,
  supplierStatus: error?.confirmedNotAccepted === true ? 'failed' : 'not_submitted',
  supplierErrorCode: typeof error?.code === 'string' ? error.code : 'SUPPLIER_SUBMISSION_FAILED',
  supplierResponseStatus: Number.isInteger(error?.responseStatus) ? error.responseStatus : null,
  ...(error?.supplierDiagnostics ? { supplierDiagnostics: error.supplierDiagnostics } : {}),
});