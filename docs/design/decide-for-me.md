# Decide for me: letting the assistant decide

Status: adopted, 2026-11-05: the [MVP](mvp.md) builds it for the inbox in slice 4, with the standing offer of its decision 5. First proposed 2026-10-27. It follows the product owner's direction that every place where a person decides can be handed to the assistant, and that this is a design philosophy rather than one button. How it looks follows the [UI philosophy](ui-philosophy.md): quiet, on piles rather than on every item. Companion documents: [UI principles](ui-principles.md) and [Statements at scale](statements-at-scale.md). A Chinese copy is in [docs/zh/design/decide-for-me.md](../zh/design/decide-for-me.md).

## The principle

Wherever the product asks a person to decide, the person can let the assistant decide instead. The decision is still theirs. The assistant decides with that person's rights and in their name, gives its reasons, and the person can undo it. People still decide; they also decide how much they decide themselves.

This replaces "the assistant proposes, people decide" with "every decision has a person, who can let the assistant decide" (principle 5 in the [UI principles](ui-principles.md)).

It is a property of every decision point, not a feature of one screen. A new screen that asks someone to decide gets Decide for me as well, with the same rules.

## Where it applies

| Decision | Who decides today | What the assistant can decide for them |
| --- | --- | --- |
| Review due | Topic owner | Confirm what still holds, mark what changed as Outdated |
| Conflict | Topic owners, or the space owner after a split or a deadline | Choose a value, or keep both with their scopes |
| Joint approval vote | Each voter | That voter's own vote |
| Publish request | The approver | Approve, ask for changes, or decline |
| Batch change review | Topic or space owner | Follow the suggestions, or hand topics back to their owners |
| Topic changes | Topic or space owner | Confirm or keep a proposed split, move or new topic |
| Unfiled statements | Topic owner | File them under the suggested topic |
| Notes | Topic owner | Acknowledge them |
| Deleted source | Topic or space owner | Keep, point to a replacement, or retire |
| Handover | Space owner | Accept the proposed new owners |

Some decisions are **never made for you**. Decide for me still works there, but it only prepares the decision: the assistant picks an option, says why, and the person confirms with one press. These are:

- **Who can read or use knowledge.** Who can read a space, members and their roles, apps with access, a consent screen, and a source whose permissions tightened.
- **What cannot be undone.** Erasing a personal space, deleting data, and anything sent outside the company.
- **Money.** Plans, seats and usage limits.

## Three ways to delegate

1. **These.** The overview at the top of the inbox, a queue or a batch change review, and each inbox card, offer one action that settles everything the assistant may settle. It leaves the rest in place, so a card can end as "Decided 14 · Left 3 for you". This is where Decide for me is seen most.
2. **This one.** On a single decision, the assistant's choice is already selected and marked Suggested, with its reason; Enter accepts it. The `d` key, ⌘K and the command `inspiration decide --for-me <item>` decide an item without opening it. There is no Decide for me button on every item.
3. **Always, for one kind.** "Always decide this kind for me" sets a standing delegation: a kind of decision, a scope (a space, an area or a topic) and, if wanted, a condition, such as "reviews in Suppliers when the source changed only its wording". Standing delegations are listed in the inbox under Always decide for me, where each can be paused. After someone accepts the assistant's suggestion for one kind five times in a row, the assistant offers to always decide it; it is never switched on without asking.

## How the assistant decides

- **With that person's rights only.** It sees and changes nothing the person could not.
- **In the order a careful person would.** First the space's rules (from "Make this a rule"), then the person's own earlier decisions in the same scope, then the authority and date of the sources. Counts of documents are only a hint, as everywhere else.
- **Always with reasons.** Every decision carries one or two sentences on why and the passages it read, so the person can check it in seconds.

## When it leaves a decision to the person

The assistant leaves a decision to the person, with its suggestion and a one-line reason, when:

- **It is not sure.** The evidence is even, or its confidence is below the bar for that kind of decision.
- **People disagree.** Another person has already decided differently in the same case, or someone left an open comment on it. The assistant never outvotes a person: in a joint approval it casts only its own person's vote, and when two people's votes split, it only prepares the decision for the space owner.
- **The space owner kept it for people.** A space owner can mark kinds of decisions as people only for the space, such as conflicts about prices.
- **It is never made for you**, as listed above.

Decisions left to the person stay where they were, in the same order, marked "Left for you" with the reason.

## Records and undo

- **The record says who and how.** A delegated decision is recorded like any other, as decided by that person, with "by the assistant" and how it was asked: this one, these, or a standing delegation. The record keeps the reasons, the passages read, and the model task and prompt version. Trace, History and the audit log show it the same way.
- **Readers see no difference.** A delegated decision is a decision. Readers see its result, as always.
- **Undo is always there.** From the decision itself, its record, or the inbox. Undoing restores the earlier state and reopens the item for the person. Knowledge is never deleted, so undoing is a new decision that restores the old one. Undoing an approved publish request retires what was published and returns the request to review.
- **Undo teaches.** When a person undoes two of the assistant's last ten decisions of one kind, the standing delegation for that kind pauses and asks the person before it continues.
- **A weekly summary.** The inbox has a Decided for you view: what the assistant decided this week, what it left, and what the person undid. It needs no action and sits outside the weekly budget of cards.

## Who controls it

- **Each person** controls their own delegation.
- **A space owner** sees the standing delegations in the space and can mark kinds of decisions as people only. In a joint approval, the space's approval settings say whether votes may be delegated; by default they may.
- **The super admin** can turn Decide for me off for the whole company, for example for an audit, and sees in usage how many decisions were delegated, never what they were about.
- **Delegated decisions are model work** and count in the member's usage.

## What the engine needs

The rule below changed with the MVP's adoption ([open question 9](../decisions.md#open-questions)). The rest is what slice 4 builds.

- **The rule.** `AGENTS.md` says built-in agents only read or propose, and that nothing an agent does changes knowledge without a person approving it. Overview requirement AG-4 says agents running on their own only read or propose, and that a member's explicit request is the approval for an edit within that member's rights. Delegation keeps the agent side as it is: the assistant still only proposes. What changes is the approval. Pressing Decide for me is an explicit request, so it already fits AG-4. A standing delegation is a request made in advance, scoped and revocable, so AG-4 has one addition, agreed on 2026-11-05: "a standing delegation the member set up, and can pause, also counts as the member's approval, within that member's rights".
- **Who owns it.** Collaboration, which owns todos, the inbox and resolving them. A delegation is a member's setting over their own todos.
- **Contracts, all additive** (`collab.yaml`, `api.yaml`). `TodoDecision` holds the todo as it was closed, the resolution and its label, the reasons, the passages read, how it was asked (`assistant_once`, `assistant_batch` or `delegation`), in whose name, when, and when it was undone. On an inbox todo, `TodoSuggestion` is what the assistant would choose and `TodoLeft` is why it left the todo. `Delegation` is one per member in the MVP: its state (`unset`, `on`, `paused`), the kinds it decides (`review_due`, `stale`, `conflict`, `note`), and who paused it. A person's own resolution is recorded on the todo, as before.
- **No model task in slice 4.** The component that asks the question already weighs the evidence the assistant decides by. Governance proposes a value by authority and date. Freshness knows whether a document changed since its last review. Each attaches its suggestion, and whether it is sure, when it asks. The assistant decides from that and from the rules in [When it leaves a decision to the person](#when-it-leaves-a-decision-to-the-person), and writes its reasons from language packs, in the member's language. Deciding a card is then a lookup, answered at once. A model task (`collaboration.decide_todo`, with its stand-in) comes only if those rules leave too much to people.
- **The API.** All of these act as the member. The writes need `knowledge.propose`.
  - `POST /v0/inbox/decide` takes `DecideTodos` (one card or a few todos) and answers `Decided`, which holds the decisions and what was left.
  - `POST /v0/decisions/:decision/undo` answers the reopened `InboxTodo`. It answers 409 when the decision is already undone or a later decision replaced it.
  - `GET /v0/inbox/decided` answers `DecidedWeek`.
  - `GET /v0/delegation` answers the member's `Delegation`, and `PUT /v0/delegation` with `PutDelegation` turns it on or pauses it.
- **Evaluation.** Before the assistant offers to always decide a kind of decision, measure how often its decisions match people's on that kind. In the mocked prototype, the numbers measure the flow, not the quality.

## Still open

- The confidence bar per kind of decision, and how it is measured with real models.
- Whether every vote in a joint approval may be delegated, so that a conflict can be decided without any person voting. Proposed: yes, unless the space owner marks conflicts as people only.
