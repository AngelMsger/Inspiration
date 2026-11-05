# Outside evidence

Research from outside the project, read against our own results so that a claim can cite it at its true weight. Each entry gives its bottom line first, then what the work shows, how it bears on our claims, its limits and what we can use. Sources are linked, not copied. The results they are read against are in [Validating the knowledge core](design/validation.md). A Chinese copy is in [docs/zh/outside-evidence.md](zh/outside-evidence.md).

## Conclusions so far

1. **One paper so far. It supports the mechanism behind governance, not the size of its lead or its cost.** Liu (2026) finds that in retrieval a model fails when its input holds rival values for the asked fact, not when the input is long. That is why settling outdated and conflicting values before an answer should help, and it matches where our lead comes from: +6.9 points over the mature RAG on changed or conflicting questions, and no difference on the controls. The paper does not test rivals that carry dates or sources, a RAG baseline, cost, speed or governance's own cost, so our decisive test stays the main evidence.
2. **Neither the paper nor our runs say that a smaller input is more often right.** Raw long context, reading whole topics of about 220,000 tokens, answered 252 of 276, ahead of every arm that reads a few thousand tokens. A small governed input is our case on cost and speed, and that case rests on our own measurements.

## Length Is Cheap, Competition Is Not (Liu, 2026)

Yinuo Liu, *Length Is Cheap, Competition Is Not: Attention Predicts Context Rot in Retrieval*, [arXiv:2611.04169v1](https://arxiv.org/abs/2611.04169v1), version 1 of 2026-11-03, by one author at UC San Diego; a preprint, not yet reviewed. The [code](https://github.com/yliusci/length-is-cheap) and all 126,473 trial-level measurements ([dataset](https://huggingface.co/datasets/yliusci/length-is-cheap), MIT) are public. Read in full on 2026-11-05 through [Hugging Face's paper page](https://huggingface.co/papers/2611.04169), since the project's cloud sessions cannot reach arxiv.org; the numbers below are version 1's.

**Bottom line: moderate support for why governance should help on conflicting facts; none for how much, for cost or speed, or for what governance itself costs.**

### What it shows

The task is a synthetic lookup ("The secret code of the river is 4821", then "what is the secret code of the river?"), on five open models of 0.5B to 3B parameters, at 512 to 32,768 tokens. Each comparison holds the length and the evidence's position fixed and changes only what surrounds the evidence.

- Neutral text costs almost nothing: accuracy stays at 0.97 to 1.00, up to 32K tokens on Qwen2.5-1.5B and up to 4K on three other models (OLMo-2-1B is the exception).
- Statements in the evidence's format at the same positions drop accuracy to 0.11 to 0.21 at 8K to 32K tokens. Nearly all of that loss comes from statements that give the asked key another value: with none, accuracy is 0.97 to 1.00; with one, 0.25 to 0.52; each further rival adds to the loss. Statements that share only the format explain at most 0.3% of it.
- The attention the model leaves on the evidence predicts the loss: 35 to 58% of its variance over 126,473 trials, against 2 to 8% for the logarithm of length. There is a threshold: on Qwen2.5-1.5B the loss stays near zero until that attention falls to about 0.35, then rises steeply.
- Hiding filler from attention while keeping its positions, the protocol behind the claim that length alone hurts, costs 46 points of accuracy at 32K tokens in retrieval, where the same filler left visible costs none.
- Its advice: "deduplicating and resolving conflicting statements before they reach the model should matter more than shortening the context", because "context engineering, not context length, is the lever".

### How it bears on our claims

| Our claim | What the paper says | Our own evidence |
| --- | --- | --- |
| Governed answers are more often right on changed and conflicting facts | Supports the mechanism: rival values for the asked fact cause the failures, not length | Decisive test after the governance fix (2026-11-04): Inspiration 248 against the mature RAG's 234 of 276: +6.9 points on the 204 changed or conflicting questions, 70 each on the 72 controls. Governed long context answers all 27 changes announced elsewhere, raw long context 16. On the company drive (2026-11-01), an old $2,500 limit was answered as current because older copies' rows ranked above the current passage |
| Where governed sources disagree, an answer names every value | Consistent: a rival left in the input with nothing to choose by makes the answer a guess | After the fix (2026-11-04), with both values in its input and neither marked, governed long context named one side and answered 11 of 24 (raw long context 21); the MVP marks disputed values in what an answer reads |
| A small governed input lets a weaker, cheaper model answer | Weakly consistent: models of 3B or less are near perfect when no rival is present, on a lookup far simpler than our questions | Decisive test, first run (2026-11-03): the compact answer ties the mature RAG (233 each) with 1,961 input tokens against 8,954. Company drive (2026-11-01): on GPT-6 Luna, Inspiration ties it (134 each) |
| A small input costs less and answers faster | Silent; and length alone does not make answers right | Decisive test, first run (2026-11-03): compact CNY 0.0012 against the mature RAG's 0.0083 an answer, model median 1.40 s against 1.73 s |
| Governance repays its cost in model calls and people's time | Silent; it hints that governance can stay narrow, since only rivals for the same fact cost accuracy | The ledger in [Governance against what answers save](design/validation.md#governance-against-what-answers-save); after the fix (2026-11-04), 33 todos per 100 documents without "Decide for me" |

### Limits

- **The rivals carry nothing to choose by.** A rival is as dated and as authoritative as the evidence, so with one rival a model can only guess, and 0.25 to 0.52 is at or below the 0.5 of a coin flip. The paper shows that an unsettled conflict makes an answer unreliable, not that a model cannot settle a conflict whose sides carry dates and sources. A mature RAG's rule, "prefer the governed source, then the newest file", settles many of those, which is why our lead over it is 5 to 7 points and not the tens of points the paper's numbers would suggest.
- One synthetic task and models of 3B parameters or less (a 7B model only in a reasoning replication); no real documents and no search. It cannot speak to search misses, which caused every answer Inspiration lost to the mature RAG on the company drive.
- Correlational by its own account: nothing intervenes on attention. In its competing filler the number of conflicts grows with length and every input of 4,096 tokens or more holds one, so statements that share only the format are measured only up to 2,048 tokens. The conflict analysis was not preregistered.
- A new preprint by one author. Hugging Face's abstract gives 0.16 to 0.33 and 45 points where version 1's full text gives 0.11 to 0.21 and 46; the numbers here are version 1's, and a citation should name the version.

### What we can use

- **Where to spend governance.** Accuracy is lost to other values for the same fact, not to near-duplicates that agree. That supports aiming governance at fact slots that hold more than one value (changes, conflicts, lagging copies and translations) and keeping copies that agree out of people's review, which bears on governance's cost, our main risk.
- **How to say it.** "What the input holds decides, not how long it is" is a fair one-line framing, cited as a preprint on a synthetic task. It is not evidence of our lead or of our cost.
- **When the validation line resumes.** For each question and arm, count the values in the answering model's input that rival the key's value, at no model cost, as the evidence audit reads those inputs, and check whether the count predicts wrong answers across arms. If it does, the larger dataset can show which questions governance can win before any paid run. The paper's attention measure needs open weights, so it does not apply to the hosted models we answer with.
