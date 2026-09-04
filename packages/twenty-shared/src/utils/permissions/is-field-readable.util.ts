import { type RestrictedFieldsPermissions } from '@/types/RestrictedFieldsPermissions';

// Field permissions default to allow; only an explicit false removes read access.
export const isFieldReadable = (
  restrictedFields: RestrictedFieldsPermissions | undefined,
  fieldMetadataId: string,
): boolean => restrictedFields?.[fieldMetadataId]?.canRead !== false;
