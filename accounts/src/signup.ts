// Who may create a folder-sync account (PEP 0003 §6, as Vibe Tracks' PEP 0011b): the emails in SIGN_UP_EMAILS (a
// secret, comma- or space-separated), or anyone when it holds "*". Unset or empty, nobody new can. People who already
// have an account always sign in.
//
// WHY a list: signing up hands out storage (a prefix of the operator's bucket and keys to write into it), so a stranger
// with a Google account must not get any until Zach opens it. WHY a secret, not a var: it holds real emails.
// WHY closed when unset: the operator sets the secrets one `wrangler secret put` at a time, in any order, and sign-in
// works as soon as Google's two are in; an open default would hand storage to whoever came first in between.

export function signUpAllowed(email: string | null | undefined, list: string | undefined): boolean {
	const allowed = (list || "").split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
	if (allowed.includes("*")) return true;
	return !!email && allowed.includes(email.trim().toLowerCase());
}
