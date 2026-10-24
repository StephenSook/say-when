# Confirm-Gated Form Errand

Fill a web form for someone who cannot type, read every answer back to them, and send it only after they confirm what they heard.

## What it does

- **Inspect** lists the questions on a form, with their choices and which ones are required. Read-only.
- **Preview** fills the form in a real browser, reads each value back off the page, and returns a sentence to speak aloud, a 16-character digest of what the page holds, and a screenshot. It never presses send.
- **Submit** sends only when you pass `confirm: true` and the digest from the preview, and only if the page still holds exactly what was read back. The same digest cannot be sent twice within ten minutes, so a double confirm sends once.

The model planning the answers never clicks. This Actor does the clicking, deterministically, and the person is the one who says yes.

## Who it is for

It was built for [Say When](https://github.com/StephenSook/say-when), a screenless assistant for people who cannot speak or use their hands. The person hears the read-back in an earpiece and confirms with a head-worn switch, such as a jaw clench or a deliberate eye movement. Anyone building assistive or human-in-the-loop agents can use it the same way: preview, let a person confirm what they heard, then submit.

## Try it in a minute

1. Run the Actor with the default input. It uses `formUrl: "demo"`, a Care team request form built into the Actor that sends nothing anywhere.
2. Open the result. You get `status: "previewed"`, a `readBackText` like the one below, a `previewDigest`, and a screenshot of the filled form.
3. Run it again with the same answers plus `"mode": "submit"`, `"confirm": true` and `"confirmDigest": "<the previewDigest>"`. You get `status: "submitted"` and the confirmation text.

```text
To Care team request. Who is this from: Demo user. What do you need: Meal or drink. Details: Lunch at the cafe
across the street, plus a note saying how it was sent. When: 12:30 today. How urgent: Today. Confirm to send.
```

## Which forms it will fill

Filling and sending need the form owner's consent, or the operator's:

- **Owner opt-in.** Put `form-errand:allow` anywhere in the form's description (in Google Forms, edit the description under the title), or add `<meta name="form-errand" content="allow">` to your own page.
- **Operator allowlist.** Whoever runs a copy of this Actor can list form address prefixes in the `ALLOWED_FORM_PREFIXES` environment variable, separated by commas. A prefix matches only at a path boundary.

Any other form can be inspected, but not filled or sent.

## What it refuses

Each refusal comes back as a code plus one short sentence written to be spoken aloud.

| Code | When |
|---|---|
| `captcha` | The page has a CAPTCHA. It never tries to get past one. |
| `login` | The page asks for a password or sends you to a sign-in page. |
| `payment` | The page asks for card details or loads a payment widget. |
| `upload` | The page asks for a file upload. |
| `bad_url` | The address is not HTTPS, or has credentials in it. |
| `not_allowed` | The form has not opted in and is not on the allowlist. |
| `unmatched_fields` | An answer did not match a question. Nothing partial is ever sent. |
| `missing_required` | A required question is still empty. |
| `not_confirmed` | Submit without `confirm: true`. |
| `digest_mismatch` | The page no longer holds what was read back. |
| `no_confirmation` | Send was pressed but no confirmation appeared. Check before trying again; the same digest stays blocked for ten minutes. |

## Input

| Field | Type | Default | Notes |
|---|---|---|---|
| `formUrl` | string | `demo` (prefill) | HTTPS form address, or `demo`. |
| `mode` | `inspect`, `preview` or `submit` | `preview` | |
| `fields` | list | | Each `{ "label": "...", "value": ..., "source": "..." }`. `value` is a string, a list of strings for checkboxes, or true or false. `source` is echoed back and never typed. |
| `confirm` | boolean | `false` | Submit only. |
| `confirmDigest` | string | | Submit only. The `previewDigest` the person confirmed. |
| `submitButtonText` | string | `Submit` | Visible name of the send button. |
| `confirmationPattern` | string | `recorded\|received\|thank\|submitted\|sent` | Regular expression for the confirmation page. |
| `disclosureText` | string | `Sent with an assistive switch after a spoken read-back and a confirm.` | Added to one paragraph answer so the recipient knows how it was sent. Empty turns it off. |
| `disclosureField` | string | last paragraph question | Which paragraph question gets the note. |
| `includeScreenshot` | boolean | `true` | Standby only: return the screenshot inline as base64. |

Supported questions: short answer, paragraph, single choice, checkboxes, native dropdowns and single checkboxes. Custom dropdown widgets and date pickers are not supported yet.

## Output

The full result is stored as `OUTPUT` in the run's key-value store, one summary row goes to the dataset, and screenshots are stored under `SCREENSHOT-PREVIEW-<digest>` and `SCREENSHOT-CONFIRMATION-<digest>`.

```json
{
  "status": "previewed",
  "mode": "preview",
  "formTitle": "Care team request",
  "fillAllowed": true,
  "readBack": [
    { "label": "Who is this from?", "value": "Demo user", "matchedBy": "label", "source": "memory" },
    { "label": "What do you need?", "value": "Meal or drink", "matchedBy": "group" }
  ],
  "readBackText": "To Care team request. Who is this from: Demo user. ...",
  "previewDigest": "3172ba2e39fc4791",
  "unmatched": [],
  "missingRequired": [],
  "refusal": null,
  "confirmationText": null,
  "screenshotUrl": "https://api.apify.com/v2/key-value-stores/.../records/SCREENSHOT-PREVIEW-3172ba2e39fc4791",
  "timings": { "loadMs": 650, "fillMs": 932, "submitMs": null, "totalMs": 2928 }
}
```

The values above come from a local run on the built-in demo form.

## Standby API

For low latency the Actor also runs as a warm web server. Open the **Endpoints** tab to send requests from the browser, or call the Standby URL shown there with your Apify token:

- `POST /inspect` lists the questions.
- `POST /preview` fills, reads back and returns the screenshot inline. It never sends, even if you pass `mode: "submit"`.
- `POST /submit` sends, with the same gates as a normal run.

Requests run one at a time on one warm browser. In our local measurement on the built-in demo form, a cold preview took about 5 seconds and a submit about 3 seconds.

## Honest limits

- Tested on native HTML forms and on an ARIA form modeled on Google Forms markup (radio groups, labelled inputs, question cards). Other form builders may use widgets it cannot fill; preview tells you which answers did not match before anything is sent.
- The digest proves the page held the read-back values at the moment of sending. It cannot prove the person understood them, which is why the read-back is short and spoken.
- Run logs never print answer values, but the result and screenshots in your storage contain them. Delete runs you do not need.

## Pricing

Pay per usage: you pay only the Apify platform compute your runs use. The Actor adds no charge of its own.

## Source

Open source under the MIT license in [StephenSook/say-when](https://github.com/StephenSook/say-when/tree/main/apify/form-errand). Built at Cal Hacks 13 with Claude Code.
