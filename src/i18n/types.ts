import type { en } from './messages/en';

/** Every translatable string. English is the source catalog and the type authority for all others. */
export type MessageKey = keyof typeof en;

/** CLDR plural categories; `other` is mandatory. Languages without plurals can use a plain string. */
export interface PluralForms { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string }
export type MessageValue = string | PluralForms;

/** A message descriptor that is rendered in the active language at display time. */
export interface Msg { key: MessageKey; params?: Record<string, ParamValue> }
export type ParamValue = string | number | Msg;

type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;
/** A string that mentions every placeholder in `P`, so a translation cannot silently drop a parameter. */
type Mentions<P extends string> = [P] extends [never] ? string : UnionToIntersection<P extends string ? `${string}{${P}}${string}` : never>;
type Template<V> = V extends string ? V : V extends { readonly other: infer Other extends string } ? `{count}${Other}` : never;

export type ParamNames<K extends MessageKey> = Placeholders<Template<(typeof en)[K]>>;
/** `t('key')` for plain messages; `t('key', { ... })` with exactly the declared placeholders otherwise. */
export type ParamArgs<K extends MessageKey> = [ParamNames<K>] extends [never] ? [] : [params: { [P in ParamNames<K>]: ParamValue }];

type Localized<V> = V extends string ? string & Mentions<Placeholders<V>> : MessageValue;
/** The shape every non-English catalog must satisfy: same keys, same placeholders. */
export type Catalog = { readonly [K in MessageKey]: Localized<(typeof en)[K]> };

export type Translate = <K extends MessageKey>(key: K, ...args: ParamArgs<K>) => string;
