import { PhoneSearchFieldLifecycleService } from 'src/engine/core-modules/phone-search-index/services/phone-search-field-lifecycle.service';

describe('PhoneSearchFieldLifecycleService', () => {
  it('creates, renames, toggles, then tombstones a field before durable purge', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const dataSource = {
      query,
      transaction: jest.fn().mockImplementation((fn) => fn({ query })),
    };
    const service = new PhoneSearchFieldLifecycleService(dataSource as never);
    const base = {
      workspaceId: 'w',
      objectMetadataId: 'p',
      fieldMetadataId: 'f',
    };
    await service.create({
      ...base,
      fieldUniversalIdentifier: 'u',
      physicalFieldName: 'mobile',
      isActive: true,
    });
    await service.rename({ ...base, physicalFieldName: 'mobilePhone' });
    await service.setActive({ ...base, isActive: false });
    await service.markDeleting(base);
    const createStateCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO core."phoneSearchFieldState"'),
    );

    expect(createStateCall?.[1]).toEqual([
      'w',
      'p',
      'f',
      'u',
      'mobile',
      true,
      1,
    ]);
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).toContain(
      "'PURGE_FIELD'",
    );
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).toContain(
      "'DELETING'",
    );
  });
});
