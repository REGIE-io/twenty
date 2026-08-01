import { defineViewField } from 'twenty-sdk/define';

import { CALL_RECORDER_PREFERENCE_ON_CALENDAR_EVENT_FIELD_UNIVERSAL_IDENTIFIER } from 'src/constants/call-recorder-preference-on-calendar-event-field-universal-identifier';
import { CALL_RECORDER_PREFERENCE_ON_CALENDAR_EVENT_VIEW_FIELD_UNIVERSAL_IDENTIFIER } from 'src/constants/call-recorder-preference-on-calendar-event-view-field-universal-identifier';
import { CALENDAR_EVENT_RECORD_PAGE_FIELDS_VIEW_UNIVERSAL_IDENTIFIER } from 'src/constants/calendar-event-record-page-layout-universal-identifier';

export default defineViewField({
  universalIdentifier:
    CALL_RECORDER_PREFERENCE_ON_CALENDAR_EVENT_VIEW_FIELD_UNIVERSAL_IDENTIFIER,
  viewUniversalIdentifier:
    CALENDAR_EVENT_RECORD_PAGE_FIELDS_VIEW_UNIVERSAL_IDENTIFIER,
  fieldMetadataUniversalIdentifier:
    CALL_RECORDER_PREFERENCE_ON_CALENDAR_EVENT_FIELD_UNIVERSAL_IDENTIFIER,
  position: 8,
  isVisible: true,
  size: 150,
});
