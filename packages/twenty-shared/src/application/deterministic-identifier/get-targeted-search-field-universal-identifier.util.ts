import { computeDeterministicUuid } from '@/application/deterministic-identifier/compute-deterministic-uuid.util';

// Secondary vectors must not collide with the legacy generic-search identifier,
// whose identity intentionally remains the source field alone.
export const getTargetedSearchFieldUniversalIdentifier = ({
  applicationUniversalIdentifier,
  fieldMetadataUniversalIdentifier,
  tsVectorFieldMetadataUniversalIdentifier,
}: {
  applicationUniversalIdentifier: string;
  fieldMetadataUniversalIdentifier: string;
  tsVectorFieldMetadataUniversalIdentifier: string;
}): string =>
  computeDeterministicUuid({
    entityNamespace: 'searchFieldMetadata',
    value: `${fieldMetadataUniversalIdentifier}:${tsVectorFieldMetadataUniversalIdentifier}`,
    applicationUniversalIdentifier,
  });
