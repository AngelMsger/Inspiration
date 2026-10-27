# Knowledge and language

Status: adopted principle, 2026-10-26, from the product owner's comment on the overview: knowledge is knowledge, and language is only one form in which it is expressed; this runs through the whole system design. Designed, not built, except where a section says so. A Chinese copy is in [docs/zh/design/knowledge-and-language.md](../zh/design/knowledge-and-language.md).

## The principle

Every unit of knowledge has an identity that does not depend on language: a statement, a fact slot and its value, an entity, a topic, a procedure, a page. Language belongs to the expressions of that knowledge: the verbatim text of a source, a label, the prose of a page, an answer. Four rules follow.

1. **One unit, many expressions.** The same knowledge in two languages is one unit with two expressions, never two units. Nothing is duplicated because it was written twice.
2. **Meaning is compared, never wording.** Two languages cannot disagree by wording. A conflict is about meaning, such as two values for one fact. A translation that falls behind its original is a stale copy, not a second opinion.
3. **Evidence keeps its language.** Quotes stay verbatim in the language of their source, and the rule that a quote is an exact substring of its passage does not change. A translation shown to a reader is labelled machine translation, with the original one click away. What people write is never translated silently.
4. **People read in their own language.** What a person reads is rendered in their language from the same knowledge, and says when it was written by a machine.

## Where language lives

| Unit | Language-neutral part | Expressions in a language |
| --- | --- | --- |
| Source version | Its identity, blocks and spans with stable IDs, and its language and each block's language as recorded facts | The text itself, verbatim |
| Statement | Its meaning: type, subject entity, predicate, qualifiers, typed value, the time it is true | The statement text of each claim that expresses it; evidence quotes in their source language |
| Fact slot | Its key: subject entity ID, predicate key, qualifier keys. Values are typed and normalized ("600 元" and "CNY 600" are both 600 CNY per night) | Labels of the predicate and qualifiers in English, Chinese and Japanese, and the aliases that recognize them in documents |
| Entity | ID, type and external keys (credit code, employee ID, SKU) | Names and aliases per language and script (北京, Beijing) |
| Topic | Its key and place in the knowledge tree | Its title and summary per language |
| Page and procedure | Their structure: sections and steps bound to statements | Prose per language. The space's content language is the canonical rendering |
| Answer | The statements and passages it uses | The asker's language; quotes stay in their original |
| Todo, note, event | Codes and parameters | Each recipient's language (as designed for the business layer) |

Built today: the language of a source version and of a claim is a recorded field, predicate keys are language-neutral, and values are typed and normalized. A translation its source states (in a folder, "leave-policy.zh.md" beside "leave-policy.md") is linked to its original, and governance counts the two as one source ([control corpus](../../examples/control/README.md), translated-policy). Where a translation states another value than its original, the original holds without a person, and an edit of the original gives its translations a review until they are translated again ([Kubernetes pages](../../examples/kubernetes-docs/README.md) in English, Chinese and Japanese). Not built: qualifier keys (the demo catalogue uses Chinese words as keys), per-language aliases beyond Chinese, entity resolution, and everything below.

## Through the pipeline

- **Normalization** records the language of each document and block, and links translations. A document is a translation of another when its source says so (language versions in Feishu, Confluence or Notion), or when alignment shows it: the same structure, the same numbers and dates, and block-by-block similarity of multilingual embeddings. A link the source states is stored as `DocumentMetadata.translation_of` (built for folders); a link the engine detects is normalization's own record, since a version is immutable once written.
- **Extraction** fills a statement's meaning in language-neutral form: predicate and qualifier keys from the catalogue, entity IDs after resolution, typed values. The statement text stays in the source language, and the prompt states that language.
- **Statements merge across languages.** Candidates come from multilingual embeddings and from sharing a fact slot. They merge only when a model check confirms the same meaning, conditions included, never on similarity alone. The merged statement keeps every claim's evidence, each quote in its own language. This is the claim merge into canonical statements that governance already plans, applied across languages.
- **Entity resolution works across languages and scripts:** external keys first, then names and aliases per language, transliteration and the catalogue's lists, then a model check.
- **Governance compares meaning.** Support counts independent sources, and a translation counts with its original, never as a second source (built for links the source states). A disagreement between a document and its own translation is not a conflict between sources: the original holds, and the translation gets a "translation out of date" review attached to the original's change, the way a copy left behind by an edit gets one today (built for links the source states). Two independent documents in different languages that state different values are a real conflict; the reviewer sees each value's quotes in their language, with a labelled translation.
- **Freshness** gives a translation the review that copies already get when their original changes (built for copies, and for translations the source states).
- **Topics** cluster with multilingual embeddings, so one topic gathers statements from every language. A topic's title and summary are written per language.
- **The page compiler** builds a page's structure once and renders its prose per language. The canonical rendering is the space's content language. A reader can ask for a page in their own language: it is compiled in that language from the same statements, not translated from the page's text, and it is labelled machine-written. Quotes stay in their original language. A person's edit is written in one language; other renderings carry it as a labelled translation.
- **Retrieval** uses multilingual embeddings and a full-text index per language (designed). A statement found in several languages comes back as one result, with its other languages listed.
- **The UI** shows one item per unit of knowledge. The Trace view lists the evidence in every language, and a reader sees their own language with the original one click away.

## Acceptance tests

The work is done when these cases pass on the in-memory doubles and the stack, with a multilingual evaluation corpus (English, Chinese and Japanese) of translations, independent documents and real disagreements:

| Case | Expected |
| --- | --- |
| A Chinese policy and its English translation state the same limit | One slot value. Support counts one document and its translation, not two. No conflict |
| The Chinese original changes 600 to 650 and the English translation does not | 650 holds. The translation gets a "translation out of date" review attached to the original's change. No conflict todo for the topic owner |
| Independent Japanese and Chinese documents state different limits | A conflict, with each value's quotes in their own language and a labelled translation for the reviewer |
| The same procedure step appears in Chinese and English as plain statements without a slot | One statement with two pieces of evidence; search returns one result |
| Two statements in different languages look alike but differ in a condition | Not merged: the model check rejects it |
| A Chinese reader asks for a page of an English space in Chinese | The page is compiled in Chinese from the same statements and labelled machine-written; quotes stay in English |

The first two cases pass today for translations the source states, in the control and Kubernetes corpora.

## Contract changes

All additive; see [docs/contracts.md](../contracts.md) for the process.

- `DocumentMetadata` gains optional `translation_of?: SourceRef`, the original document as the source states it, and reaches the version with the rest of the metadata (built). A detected link is kept by normalization, which says how it was found, rather than as `translation_basis` on the immutable `SourceVersion` this section first proposed.
- `Claim` gains optional `expressions[] { language, statement, claim_ids }` on a canonical statement merged across languages. Each member claim keeps its own `language`, statement and evidence.
- `Entity` gains optional `names[] { language, name, aliases }`; `name` stays the default display name.
- `TaxonomyNode` gains optional `titles { <locale>: string }`; `title` stays the canonical one.
- `PageSpec.locale` names the language of a rendering, and a rendering in another language gains `rendering_of?: PageId`, pointing to the canonical page.
- The predicate catalogue (configuration, not a contract yet) gives every predicate and qualifier a language-neutral key with labels and aliases in English, Chinese and Japanese.

## Engine work

The internationalization work in the overview already covers language detection, per-language aliases and language-neutral slot keys. This adds:

| Component | Change | Person-weeks |
| --- | --- | --- |
| normalization | Translation links, from the source or detected by alignment | 0.5 |
| extraction, governance | Cross-language merge with a model check; translations counted with their original; "translation out of date" instead of a conflict | 1 |
| entity resolution | Names per language and script, as part of entity resolution | 0.5 |
| page-compiler | Rendering a page in another language from its statements | 1 |
| contracts, tests and evaluation | The changes above, the acceptance cases and the multilingual corpus | 0.5 |
| **Total** |  | **3.5** |

## Terms

| Concept | UI term | 中文 | 日本語 (draft) |
| --- | --- | --- | --- |
| Translation | Translation of | 译本 | 翻訳版 |
| Translation out of date | Translation out of date | 译本已过时 | 翻訳が古い |
| Machine-written rendering | Machine translated | 机器翻译 | 機械翻訳 |
| Other languages of a statement | Also in English | 另有英文版 | 英語版あり |
