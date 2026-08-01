import {
  defineView,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  ViewType,
} from 'twenty-sdk/define';

import { CALENDAR_EVENT_RECORD_PAGE_FIELDS_VIEW_UNIVERSAL_IDENTIFIER } from 'src/constants/calendar-event-record-page-layout-universal-identifier';

export default defineView({
  universalIdentifier:
    CALENDAR_EVENT_RECORD_PAGE_FIELDS_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Calendar Event Record Page Fields',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.calendarEvent.universalIdentifier,
  type: ViewType.FIELDS_WIDGET,
});
