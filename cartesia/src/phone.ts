// Phone number checks for the CALL stretch. Numbers never go into events, errors or logs.

/**
 * A North American number in E.164 (+1 and ten digits), or null. Cartesia numbers only reach US destinations.
 * N11 codes (211 to 911) are service codes, never subscriber numbers, so they are refused as area codes or prefixes.
 */
export function toUsE164(raw: string): string | null {
    const cleaned = String(raw).trim();
    if (!/^\+?[\d\s().-]+$/.test(cleaned)) return null;
    let digits = cleaned.replace(/\D/g, '');
    if (digits.length === 10) digits = `1${digits}`;
    if (!/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
    const area = digits.slice(1, 4);
    const prefix = digits.slice(4, 7);
    if (/^[2-9]11$/.test(area) || /^[2-9]11$/.test(prefix)) return null;
    return `+${digits}`;
}

const EMERGENCY = new Set(['911', '112', '999', '000', '988', '933', '110', '119', '100', '101', '102', '108', '118', '08']);

/** Emergency and crisis short codes, here and abroad, plus anything that starts like 911. This is never a 911 tool. */
export function isEmergencyNumber(raw: string): boolean {
    const digits = String(raw).replace(/\D/g, '');
    if (digits === '') return false;
    if ([digits, digits.replace(/^1/, ''), digits.replace(/^0+/, '')].some((d) => EMERGENCY.has(d))) return true;
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    return national.startsWith('911') || (national.length === 10 && national.slice(3, 6) === '911');
}

/** "+14155550123" to "415-555-0123". The SSML guide says to write phone numbers as plain text and let Sonic group them. */
export function spokenNumber(e164: string): string {
    const digits = e164.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
}
