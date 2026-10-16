import type {RailSearch,SearchResult} from '../../lib/rail-types.ts';
import type {RecommendationMode} from '../../lib/rail-recommendation.ts';

export type AssistantFilters={maxPrice:number|null;budgetScope:'person'|'group';latestArrival:string|null;maxDuration:number|null;directOnly:boolean;transferOnly:boolean;trainCodes:string[]};
export type AssistantMemory={sort:RecommendationMode;filters:AssistantFilters};
export type FormDraft={origin:string;destination:string;date:string;earliestTime:string;passengerCount:number;seats:string[];trainTypes:string[];includeTransfer:boolean;sameSeatOnly:boolean;allowOvernightTransfer:boolean;includeLongTicket:boolean;includeExtension:boolean;middle:string;minTransferMinutes:number};
export type AssistantCitation={id:string;trains:string;route:string;departure:string;arrival:string;minutes:number;price:number|null;groupPrice:number|null;passengers:number;fetchedAt:string;label:string};
export type AssistantAnswer={text:string;citations:AssistantCitation[];memory:AssistantMemory;evidenceToken?:string;retrieved:number;sampledAt?:string;degraded?:boolean};
export type AssistantQueryResult={input:RailSearch;result:SearchResult;evidenceToken?:string};
export type AssistantEvent={type:'progress';message:string}|{type:'search';input:RailSearch}|{type:'result';data:AssistantQueryResult}|{type:'answer';data:AssistantAnswer}|{type:'error';message:string};
