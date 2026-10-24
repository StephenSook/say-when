/** A value to put in one form question. Arrays are for checkbox questions with several answers. */
export type FieldValue = string | string[] | boolean;

export interface FieldInput {
    /** The question's visible label, for example "Who is this from?". */
    label: string;
    value: FieldValue;
    /** Where the value came from, for example "memory" or "maps:<placeId>". Echoed back, never typed into the form. */
    source?: string;
}

export type Mode = 'inspect' | 'preview' | 'submit';

export interface ErrandInput {
    /** HTTPS form URL, or "demo" for the built-in demo form. */
    formUrl: string;
    fields: FieldInput[];
    mode: Mode;
    /** Submit only: the person confirmed the spoken read-back. */
    confirm: boolean;
    /** Submit only: the previewDigest the person heard. */
    confirmDigest?: string;
    submitButtonText: string;
    /** Plain phrases, matched case-insensitively; one must appear on the page after submit. Never a regex. */
    confirmationPhrases: string[];
    /** Appended to a free-text answer so the recipient knows how the form was sent. Empty string turns it off. */
    disclosureText: string;
    /** Label of the free-text question that gets the disclosure. Defaults to the last paragraph question filled. */
    disclosureField?: string;
    includeScreenshot: boolean;
}

export type RefusalCode =
    | 'bad_input'
    | 'bad_url'
    | 'load_failed'
    | 'captcha'
    | 'login'
    | 'payment'
    | 'upload'
    | 'no_form'
    | 'not_allowed'
    | 'unmatched_fields'
    | 'missing_required'
    | 'not_confirmed'
    | 'digest_mismatch'
    | 'no_submit_button'
    | 'no_confirmation';

export interface Refusal {
    code: RefusalCode;
    /** One short sentence written to be spoken aloud. */
    reason: string;
}

export type ErrandStatus = 'inspected' | 'previewed' | 'submitted' | 'duplicate' | 'refused' | 'failed';

export interface ReadBackItem {
    label: string;
    /** The value read back off the live page after filling, not the value we were asked to type. */
    value: string;
    matchedBy: string;
    source?: string;
}

export interface QuestionInfo {
    label: string;
    kind: 'text' | 'paragraph' | 'select' | 'checkbox' | 'choice' | 'checkboxes';
    required: boolean;
    options?: string[];
}

export interface ErrandResult {
    status: ErrandStatus;
    mode: Mode;
    formUrl: string;
    finalUrl: string | null;
    formTitle: string | null;
    /** True when the form is on the operator allowlist or carries the owner's opt-in marker. */
    fillAllowed: boolean;
    questions: QuestionInfo[];
    readBack: ReadBackItem[];
    /** Text for the earpiece, generated from the read-back values. */
    readBackText: string | null;
    previewDigest: string | null;
    unmatched: string[];
    missingRequired: string[];
    refusal: Refusal | null;
    confirmationText: string | null;
    screenshotKey: string | null;
    screenshotUrl: string | null;
    screenshotBase64?: string;
    timings: { loadMs: number | null; fillMs: number | null; submitMs: number | null; totalMs: number };
    submittedAt: string | null;
}
