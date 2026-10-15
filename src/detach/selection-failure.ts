import type {MessageKey} from '../shared/i18n.ts'

/** Classify known local failures without displaying draft values or arbitrary errors. */
export function selectionFailure(error:unknown):MessageKey {
  const message=error instanceof Error?error.message:''
  if(/sensitive|password|autocomplete/i.test(message))return 'companionSensitive'
  if(/at most six/.test(message))return 'companionControlLimit'
  if(/exceeds|budget|limit/i.test(message))return 'companionContentLimit'
  if(/Composer editor interface/.test(message))return 'companionEditorUnavailable'
  if(/editable control/.test(message))return 'companionUnsupportedEditor'
  if(/removed|replaced|changed|connected|hidden|visible bounds/.test(message))return 'companionSourceChanged'
  if(/unrepresented|representable|graphic|resource|Generated content|Shadow DOM/.test(message))return 'companionUnrepresented'
  return 'companionUnsupported'
}
