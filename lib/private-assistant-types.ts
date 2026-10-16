import type {FormDraft,AssistantAnswer,AssistantMemory} from '../cloud/public/assistant-types';
import type {RailSearch} from './rail-types';

export type PrivateAssistantForm=FormDraft & {destinations:string[];middleStations:string[]};
export type PrivateAssistantReply={type:'search';input:RailSearch;memory:AssistantMemory}|{type:'answer';answer:AssistantAnswer};
