// Fast local first pass for D8 in PLAN.md: decide whether a partner's question needs a web or place search.
// Plain rules, no network and no model, so small talk and personal questions never wait on Apify.
// When no rule is sure, it says needsWeb: true and the planner makes the final call.

export type QuestionKind = 'places' | 'facts' | 'smalltalk' | 'personal';

export interface QuestionClass {
    /** True when a live web or place search could help the answer. */
    needsWeb: boolean;
    kind: QuestionKind;
    /** One sentence from a fixed list. It never quotes the question, so it is safe to log or show. */
    reason: string;
}

const REASON = {
    empty: 'Empty question, nothing to look up.',
    clock: 'The time and date come from the local clock.',
    placeOpen: 'Asks whether a place is open, or when it opens or closes.',
    outing: 'Plans a meal or an outing, so nearby places help.',
    nearby: 'Asks what is nearby.',
    directions: 'Asks for directions or distance.',
    place: 'Asks about a kind of place, so live place data helps.',
    weather: 'Asks about the weather.',
    news: 'Asks about news or a recent event.',
    sports: 'Asks about a game, a score or a result.',
    price: 'Asks about a price.',
    schedule: 'Asks about opening hours or a schedule.',
    when: 'Asks when something happens.',
    general: 'Asks a general knowledge question.',
    memory: 'Asks about a shared memory, so memory can answer.',
    person: 'Asks about someone the person knows, so memory can answer.',
    name: 'Mentions a name that may need a lookup.',
    smalltalk: 'Greeting or small talk.',
    feeling: 'Asks how the person feels or what they want.',
    care: 'Asks about care, comfort or family, so memory can answer.',
    plans: 'Asks about plans, so memory can answer.',
    addressed: 'Asks about the person or shared plans, so memory can answer.',
    unsure: 'Not sure, so search in case it needs outside facts.',
} as const;

const result = (needsWeb: boolean, kind: QuestionKind, reason: string): QuestionClass => ({ needsWeb, kind, reason });

// Curly and modifier apostrophes and the backtick, built from code points so the source stays ASCII.
const APOSTROPHES = new RegExp(`[${String.fromCharCode(0x2018, 0x2019, 0x02bc, 0x60)}]`, 'g');

/** Lowercase, no accents, straight apostrophes, punctuation turned into spaces. */
function normalize(text: string): string {
    return text
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(APOSTROPHES, "'")
        .replace(/[^a-z0-9'\s]/g, ' ')
        .replace(/(^|\s)'+|'+(\s|$)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// "Do you know when the pharmacy closes?" asks the same thing as "When does the pharmacy close?".
const WRAPPER =
    /^(?:(?:so|um|uh|oh|hey|ok|okay|well)\s+)*(?:do you (?:happen to )?know|any idea|can you tell me|could you tell me|did you hear|have you heard|i wonder|i was wondering)\s+(?=(?:what|when|where|who|whose|which|how|why|if|whether|about|that|the)\b)(?:(?:if|whether|about|that)\s+)?/;

const CLOCK =
    /^(?:what time is it|what time it is|what's the time|what is the time|what day is it|what day it is|what day is today|what's the date|what is the date|what's today's date|what is today's date)(?: now| right now| today)?$/;

// ---------- Questions that need outside facts ----------

const PRONOUNS = new Set(['you', 'your', 'yours', 'we', 'our', 'us', 'i', 'my', 'me', 'he', 'his', 'him', 'she', 'her', 'their', 'them']);
const HOUSEHOLD = new Set([
    'window', 'windows', 'door', 'doors', 'blinds', 'curtain', 'curtains', 'lid', 'box', 'bottle', 'jar', 'drawer',
    'fridge', 'gate', 'tab', 'app', 'file', 'eye', 'eyes', 'mouth', 'book', 'letter', 'package', 'present', 'gift', 'bag', 'mind',
]);

/** "Is the cafe on Bancroft still open?", but not "Is the window open?" or "Are you open to it?". */
function asksIfOpen(t: string): boolean {
    const m = /\b(?:is|are|was)\s+((?:[a-z']+\s+){0,4}?[a-z']+)\s+(?:still\s+)?open\b/.exec(t);
    if (!m) return false;
    const words = m[1].split(' ');
    if (words.some((w) => PRONOUNS.has(w))) return false;
    return !HOUSEHOLD.has(words[words.length - 1]);
}

const OPEN_TIMES =
    /\b(?:open|opens|close|closes|closing)\s+(?:now|today|tonight|tomorrow|late|early|yet|soon|until|till|right now|at \d|on (?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sundays|weekends?|the weekend|holidays?))\b|\bstill open\b|\bhow late\b.*\bopen\b|\bopen 24\b/;
const WHEN_OPEN =
    /\b(?:when|what time)\s+(?:does|do|is|are|will)\s+(?!(?:you|we|i|your|my|our)\b)(?:[a-z']+\s+){0,4}?(?:open|opens|close|closes|closing)\b/;
const OUTING =
    /\b(?:grab|get|go (?:out )?(?:for|to)|head (?:out )?(?:for|to)|order|pick up|try)\s+(?:some\s+|a\s+|an\s+)?(?:lunch|dinner|breakfast|brunch|coffee|food|bite|pizza|tacos?|sushi|burgers?|ramen|pho|ice cream|drinks?|takeout|boba|dessert)\b|\b(?:eat out|places? to eat|somewhere to eat|where to eat|where to go)\b|\bwhere (?:should|can|could|shall|would) (?:we|i)\b|\bwhere (?:do|would) (?:you|we) (?:want|like) to (?:go|eat|get|grab|have|meet)\b/;
const NEARBY =
    /\b(?:nearby|nearest|the closest (?:one|place|spot)|near (?:here|me|us|by|campus|downtown|the venue)|close by|close to here|around here|in the area|walking distance|within walking|downtown)\b/;
const DIRECTIONS =
    /\b(?:directions?|how far|is it far|is that far|are they far|how (?:do|can|should|would|will) (?:we|i|you) get (?:to|there|back)|how long (?:does it take|will it take) to (?:get|walk|drive)|which way|what's the address|what is the address|where is it|where's it)\b/;
const RESTROOM_WHERE = /\b(?:where|nearest|closest|find|any)\b.*\b(?:bathrooms?|restrooms?|toilets?)\b/;
const PLACE_NOUN = new RegExp(
    `\\b(?:${[
        'restaurants?', 'cafes?', 'coffee shops?', 'coffee places?', 'diners?', 'bistros?', 'bakery', 'bakeries', 'pubs?',
        'brewery', 'breweries', 'pharmacy', 'pharmacies', 'drugstores?', 'hospitals?', 'clinics?', 'urgent care',
        'grocery stores?', 'grocery', 'groceries', 'supermarkets?', 'stores?', 'shops?', 'malls?', 'markets?', 'museums?',
        'theaters?', 'theatres?', 'cinemas?', 'library', 'libraries', 'gyms?', 'gas stations?', 'atms?', 'banks?', 'hotels?',
        'airports?', 'train stations?', 'bus stops?', 'bus stations?', 'parking', 'parks', '(?:the|a|nearest|closest) park',
        'playgrounds?', 'beach', 'beaches', 'zoo', 'post office', 'venue', 'food trucks?', 'takeout', 'take out', 'delivery',
    ].join('|')})\\b`,
);

const WEATHER =
    /\b(?:weather|forecast|rain|raining|rainy|snow|snowing|temperature|degrees|humid|humidity|windy|storm|stormy|thunder|sunny|umbrella|smoke|air quality|aqi|heat wave|uv index)\b|\b(?:cold|hot|warm|chilly|freezing|nice|cool) (?:outside|out there|out today|tomorrow|tonight|this weekend)\b/;
const SMALLTALK_WEATHER =
    /\b(?:nice|lovely|beautiful|gorgeous|great|perfect|terrible|awful|horrible|crazy|weird|strange)\s+(?:day|weather|morning|afternoon|evening|out)\b/;
const FORECAST = /\b(?:will|going to|gonna|forecast|tomorrow|later|tonight|this weekend|supposed to|chance of)\b/;
const NEWS =
    /\b(?:news|headlines?|election|elections|ballot|the game|the match|the race|the fight|the debate|playoffs?|the finals?|super bowl|world series|world cup|olympics|stock market|stocks)\b/;
const NEWS_PERSONAL = /\b(?:news from|your news|my news|our news|his news|her news)\b/;
const SPORTS =
    /\b(?:who|which team)\s+(?:won|wins|is winning|lost|is playing|plays)\b|\bscores?\b|\bstandings\b|\b(?:did|do|does|will)\s+the\s+[a-z']+(?:\s+[a-z']+)?\s+(?:win|lose|play)\b|\bthe\s+[a-z']+(?:\s+[a-z']+)?\s+(?:won|lost)\b/;
const SCORE_PERSONAL = /\b(?:your|my|our|his|her) scores?\b/;
const PRICE =
    /\b(?:price|prices|pricing|cost|costs|costly|expensive|cheap|cheaper|affordable|fee|fees|discount|on sale)\b|\bhow much (?:is|are|was|were|does|do|did|will)\b(?! (?:you|i|we|u)\b)/;
const SCHEDULE = /\b(?:schedule|schedules|timetable|showtimes?|show times?|hours|opening hours|business hours|visiting hours)\b/;
const SCHEDULE_PERSONAL =
    /\b(?:your|my|our|his|her) (?:schedule|hours)\b|\bhow many hours\b|\bfor hours\b|\bhours ago\b|\bin (?:a few|two|three|\d+) hours\b/;
const WHEN =
    /\b(?:when|what time)\s+(?:does|do|is|are|was|will)\s+(?!(?:you|your|we|i|my|our|us|it|he|she|they|his|her|their)\b)(?:the|a|an|this|that|next|[a-z']+'s)\b/;
const GENERAL =
    /\b(?:who (?:is|was|are|were) the|what (?:is|are) the (?:capital|population|name of|meaning of)|what does [a-z']+ mean|how many people|how old is the|how tall is|how big is|what year|when did the|when was the|who invented|who wrote|who made|who directed|who sings|who played)\b/;

// ---------- Questions memory can answer ----------

const MEMORY = /\b(?:do|did|can) you (?:remember|recall)\b|\bremember when\b|\bdo you miss\b/;
const CARE =
    /\b(?:mom|mum|mother|mommy|dad|father|daddy|grandma|grandpa|granny|nana|papa|sister|brother|sis|bro|aunt|auntie|uncle|cousin|son|daughter|wife|husband|kids?|grandkids?|grandson|granddaughter|baby|family|nurse|caregiver|carer|aide|doctor|doc|therapist|dentist|friend|friends|boyfriend|girlfriend|partner|roommate|neighbor|neighbour|bathroom|toilet|potty|restroom|pee|meds|medicine|medication|pills?|dose|pain|hurt|hurts|sore|itch|itchy|blanket|pillow|wheelchair|glasses|hearing aid|water|juice|tea|snack|nap|sleep|bed|shower|bath|window|door|blinds|curtains|lights?|tv|television|radio|music|volume|fan|heater|heat|ac|air conditioning|thermostat|phone|charger)\b/;
const FEELING =
    /\b(?:are|were|aren't) you (?:feeling |getting |still |a bit |a little |too )?(?:tired|hungry|thirsty|cold|hot|warm|ok|okay|alright|all right|comfortable|uncomfortable|comfy|in pain|hurting|sore|sleepy|bored|ready|done|finished|awake|sick|nauseous|dizzy|happy|sad|scared|afraid|worried|nervous|anxious|excited|full|wet|itchy|stuck|lonely|upset|mad|angry|good|well|better|worse)\b|\bhow (?:are|do) you feel(?:ing)?\b|\bhow did you sleep\b|\bdoes (?:it|that|this|anything|your [a-z]+) hurt\b|\bany pain\b|^(?:hungry|thirsty|tired|sleepy|cold|hot|comfy|comfortable|ready|done|finished|better|full|warm|bored|awake)\b/;
const WANTS =
    /\b(?:do|would|did|will|could) you (?:want|need|like|wanna|mind|prefer|feel like)\b|\bwould you like\b|^(?:want|wanna|need|like)\b|\b(?:want|need) (?:some|a|an|to|me|more|anything|something|help|another)\b|\b(?:can|should|shall|may|could) (?:i|we) (?:get|bring|grab|call|help|open|close|turn|move|adjust|fix|put|change|lift|raise|lower|read|play|pause|stop|start|wipe|scratch|pour|cut)\b/;
const PLANS =
    /\b(?:plans?|schedule|appointments?|visit|visiting|visitors?|coming over|come over|stop by|stopping by|coming|leave|leaving|go home|going home|head home|ready to go)\b/;
// Lowercase transcripts carry no capitals to spot a name in, so catch "how is sarah doing" directly.
const HOW_IS_SOMEONE =
    /^how(?:'s| is| was) (?!(?:the|it|that|this|everything|everyone|your|my|our)\b)[a-z']+(?: [a-z']+)? (?:doing|feeling|holding up)\b/;
const ADDRESSED =
    /\b(?:you|your|you're|youre|you've|you'll|you'd|yours|yourself|ya|u|i|i'm|im|i'll|i've|i'd|me|my|mine|myself|we|we're|we'll|we've|us|our|ours|let's|lets)\b/;

// ---------- Small talk ----------

const GREETING_ONLY =
    /^(?:hi|hello|hey|hiya|howdy|yo|good (?:morning|afternoon|evening|night)|morning|evening|welcome back|bye|goodbye|see you(?: later| soon| tomorrow)?)(?: there| again| everyone| all)?(?: [a-z']+)?$/;
const HOW_ARE_YOU =
    /^(?:(?:hi|hello|hey|good morning|good afternoon|good evening)\s+)?(?:[a-z']+\s+)?(?:how are you(?: doing)?(?: today| tonight| this morning)?|how(?:'s| is) it going|how have you been|what's up|whats up|what is up|how's everything|how is everything|how(?:'s| is| are) everyone(?: doing)?|how's life|how are things)$/;
const HOW_WAS =
    /\bhow (?:was|is|has been|did) your (?:day|morning|afternoon|evening|night|weekend|week|trip|holiday|vacation|break|visit|class|lunch|dinner|breakfast)\b/;
const THANKS = /^(?:thanks|thank you|thank you so much|thanks so much|thanks a lot|many thanks)(?: for [a-z' ]+)?$/;
const INTERJECTION =
    /^(?:really|seriously|no way|oh really|is that right|is that so|you think|are you sure|wow|cool|nice|yeah|yes|no|ok|okay|sure|right|huh|oh|aha|haha|lol)$/;
const SMALLTALK = [
    /\b(?:did you have|are you having|having|had) (?:a )?(?:fun|good time|nice time|great time|blast)\b/,
    /\bwhat do you think\b/,
    /\b(?:isn't it|isnt it|ain't it|right|huh|eh|don't you think|wasn't it|isn't that)$/,
    SMALLTALK_WEATHER,
    /\b(?:nice to (?:meet|see) you|good to see you|long time no see|happy birthday|congrats|congratulations|merry christmas|happy holidays|happy new year|good luck)\b/,
    /\b(?:guess what|you know what)\b/,
];

interface Rule {
    kind: QuestionKind;
    reason: string;
    test: (t: string) => boolean;
}

const when = (pattern: RegExp, unless?: (t: string) => boolean) => (t: string) => pattern.test(t) && !(unless?.(t) ?? false);

/** Checked first and in order: a question that needs outside facts searches even when it is also personal. */
const WEB_RULES: Rule[] = [
    { kind: 'places', reason: REASON.placeOpen, test: asksIfOpen },
    { kind: 'places', reason: REASON.placeOpen, test: when(OPEN_TIMES) },
    { kind: 'places', reason: REASON.placeOpen, test: when(WHEN_OPEN) },
    { kind: 'places', reason: REASON.outing, test: when(OUTING) },
    { kind: 'places', reason: REASON.nearby, test: when(NEARBY) },
    { kind: 'places', reason: REASON.directions, test: when(DIRECTIONS) },
    { kind: 'places', reason: REASON.place, test: when(RESTROOM_WHERE) },
    { kind: 'places', reason: REASON.place, test: when(PLACE_NOUN) },
    { kind: 'facts', reason: REASON.weather, test: when(WEATHER, (t) => SMALLTALK_WEATHER.test(t) && !FORECAST.test(t)) },
    { kind: 'facts', reason: REASON.news, test: when(NEWS, (t) => NEWS_PERSONAL.test(t)) },
    { kind: 'facts', reason: REASON.sports, test: when(SPORTS, (t) => SCORE_PERSONAL.test(t)) },
    { kind: 'facts', reason: REASON.price, test: when(PRICE) },
    { kind: 'facts', reason: REASON.schedule, test: when(SCHEDULE, (t) => SCHEDULE_PERSONAL.test(t)) },
    { kind: 'facts', reason: REASON.when, test: when(WHEN, (t) => CARE.test(t)) },
    { kind: 'facts', reason: REASON.general, test: when(GENERAL) },
];

// ---------- Names ----------

const NOT_NAMES = new Set([
    'i', "i'm", "i'll", "i've", "i'd", 'ok', 'okay', 'tv', 'am', 'pm', 'asap', 'id', 'lol', 'omg', 'god',
    'mom', 'mum', 'mommy', 'dad', 'daddy', 'grandma', 'grandpa', 'granny', 'nana', 'papa',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    'christmas', 'thanksgiving', 'easter', 'halloween', 'english', 'spanish',
]);
const TITLES = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sir', 'aunt', 'auntie', 'uncle', 'coach', 'nurse', 'doctor', 'officer']);
const GREETINGS = new Set(['hi', 'hey', 'hello', 'thanks', 'thank', 'morning', 'evening', 'bye', 'goodbye', 'yo', 'dear', 'oh', 'ok', 'okay', 'well', 'so', 'sorry']);

const isCapitalized = (word: string): boolean => /^\p{Lu}/u.test(word);
const isAcronym = (word: string): boolean => /^\p{Lu}{2,}$/u.test(word);
const baseOf = (word: string): string => word.replace(/'s$/i, '');
const cleanWord = (word: string): string => word.replace(APOSTROPHES, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$|'+$/gu, '');

/** Capitalized words that are not sentence starts, greetings' vocatives, days, months or family titles. */
function findNames(original: string): string[] {
    const found = new Set<string>();
    // Split sentences, but not after "Dr." and similar.
    const sentences = original.split(/(?<!\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|St|Mt|Jr|Sr|vs))[.!?]+(?:\s+|$)/);
    for (const sentence of sentences) {
        const raw = sentence.split(/\s+/).filter(Boolean);
        const words = raw.map(cleanWord);
        let i = 0;
        while (i < words.length) {
            const word = words[i];
            const lower = baseOf(word).toLowerCase();
            const title = TITLES.has(lower);
            const startsName = word !== '' && (isCapitalized(word) || isAcronym(word)) && (title || !NOT_NAMES.has(lower));
            // A sentence's first word is capitalized anyway, so only an acronym or a title counts there.
            const firstOk = i > 0 || isAcronym(word) || (title && i + 1 < words.length && isCapitalized(words[i + 1]));
            if (!startsName || !firstOk) {
                i += 1;
                continue;
            }
            let j = i + 1;
            while (j < words.length && words[j] !== '' && (isCapitalized(words[j]) || isAcronym(words[j])) && !raw[j - 1].endsWith(',')) j += 1;
            const group = words.slice(i, j).map(baseOf);
            const meaningful = group.some((g) => !NOT_NAMES.has(g.toLowerCase()) && !TITLES.has(g.toLowerCase()));
            // "Hey Sam, ..." and "..., Sam?" are the partner talking to someone, not a lookup.
            const vocative = (i === 1 && GREETINGS.has(words[0].toLowerCase())) || (i > 0 && raw[i - 1].endsWith(',') && j === words.length);
            if (meaningful && !vocative) found.add(normalize(group.join(' ')));
            i = j;
        }
    }
    return [...found].filter(Boolean);
}

const PERSON_FRAMES = [
    /\bhow(?:'s| is| was| are| has) xname\b/,
    /\b(?:is|was|are) xname (?:coming|here|home|back|ok|okay|alright|awake|asleep|visiting|calling|joining|staying|sick|feeling|still|doing|around|free|busy|upset|mad|happy)\b/,
    /\b(?:did|has|have|will|does|can|could|would) xname (?:call|called|text|texted|come|came|visit|visited|stop|say|said|write|wrote|leave|left|arrive|arrived|know|want|like|get|bring|send|sent|ask|asked|reply|replied|answer)\b/,
    /\b(?:talk|talked|talking|speak|spoke|spoken|speaking|heard|hear|text|texted|texting|call|called|calling|visit|visited|visiting|tell|told|ask|asked|thank|hug|miss|remember|love|meet|met|invite|invited|email|emailed|write|wrote) (?:to |with |from |back )?xname\b/,
    /^xname (?:says|said|called|texted|asked|wants|loves|misses|sends|is coming|was here|stopped by|came by)\b/,
    /\bsay (?:hi|hello|thanks|thank you) to xname\b/,
    /\bxname's (?:birthday|party|wedding|baby|kids?|husband|wife|mom|dad|house|place|visit|news)\b/,
];
const NOT_A_PERSON = /\bthe xname\b/;
const PLACE_FRAMES = [
    /\b(?:at|to|near|from|in|by|around|inside|outside|into) (?:the )?xname\b/,
    /\bxname(?:'s)? (?:is |are )?(?:open|closed|hours|menu|location|address)\b/,
    /\bwhere(?:'s| is| are) (?:the )?xname\b/,
];

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces the focus name with "xname" and every other name with "yname", longest names first. */
function markNames(text: string, names: string[], focus: number): string {
    let out = text;
    const order = names.map((name, index) => ({ name, index })).sort((a, b) => b.name.length - a.name.length);
    for (const { name, index } of order) out = out.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'g'), index === focus ? 'xname' : 'yname');
    return out;
}

/**
 * Decides, with plain rules and no network, whether a question needs a web or place search.
 * Order: the local clock, then outside-fact rules (places, then facts), then shared memories, then names,
 * then small talk and personal rules. Anything left over is treated as unsure and searches.
 */
export function classifyQuestion(question: string): QuestionClass {
    const original = typeof question === 'string' ? question.replace(/\s+/g, ' ').trim() : '';
    const text = normalize(original);
    if (text === '') return result(false, 'smalltalk', REASON.empty);
    const asked = text.replace(WRAPPER, '') || text;

    if (CLOCK.test(asked)) return result(false, 'facts', REASON.clock);
    for (const rule of WEB_RULES) if (rule.test(asked)) return result(true, rule.kind, rule.reason);
    if (MEMORY.test(asked)) return result(false, 'personal', REASON.memory);

    const names = findNames(original);
    if (names.length > 0) {
        const marked = names.map((_, i) => markNames(asked, names, i));
        const allPeople = marked.every((t) => !NOT_A_PERSON.test(t) && PERSON_FRAMES.some((re) => re.test(t)));
        if (allPeople) return result(false, 'personal', REASON.person);
        const placeLike = marked.some((t) => PLACE_FRAMES.some((re) => re.test(t)));
        return result(true, placeLike ? 'places' : 'facts', REASON.name);
    }

    if ([GREETING_ONLY, HOW_ARE_YOU, HOW_WAS, THANKS, INTERJECTION].some((re) => re.test(asked))) {
        return result(false, 'smalltalk', REASON.smalltalk);
    }
    if (FEELING.test(asked) || WANTS.test(asked)) return result(false, 'personal', REASON.feeling);
    if (HOW_IS_SOMEONE.test(asked)) return result(false, 'personal', REASON.person);
    if (CARE.test(asked)) return result(false, 'personal', REASON.care);
    if (PLANS.test(asked)) return result(false, 'personal', REASON.plans);
    if (SMALLTALK.some((re) => re.test(asked))) return result(false, 'smalltalk', REASON.smalltalk);
    if (ADDRESSED.test(asked)) return result(false, 'personal', REASON.addressed);
    return result(true, 'facts', REASON.unsure);
}
