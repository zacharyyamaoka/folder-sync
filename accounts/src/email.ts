// Sign-in codes by email in production (PEP 0003 §3.3, review r3 #8), sent through Resend's HTTP API.
//
// WHY Resend: a Worker sends with one fetch (no SMTP, no SDK); Cloudflare's own send_email binding only reaches
// addresses verified in Email Routing, so it cannot mail a stranger signing up. The key is the secret RESEND_API_KEY
// (`wrangler secret put RESEND_API_KEY`), the sender EMAIL_FROM (a var, an address on a domain verified in Resend);
// without both, production offers no email codes. Dev never sends: its codes go to /fs/dev/mailbox.

export interface EmailEnv {
	/** Resend's API key: a secret Zach sets, never in a file. */
	RESEND_API_KEY?: string;
	/** Who the codes come from, like "Robot Parts <signin@robotparts.dev>". */
	EMAIL_FROM?: string;
}

/** Sends a sign-in code to one address, or null when delivery is not configured. Throws when Resend refuses. */
export function emailSender(env: EmailEnv, send: (request: Request) => Promise<Response>): ((email: string, otp: string) => Promise<void>) | null {
	const key = env.RESEND_API_KEY;
	const from = env.EMAIL_FROM;
	if (!key || !from) return null;
	return async (email, otp) => {
		const answer = await send(new Request("https://api.resend.com/emails", {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				from,
				to: [email],
				subject: `Your sign-in code: ${otp}`,
				text: `Your sign-in code is ${otp}. It works for 5 minutes. If you did not ask for it, ignore this email.`,
			}),
		}));
		await answer.body?.cancel();
		// WHY no detail: the answer is Resend's, and the caller's message goes to whoever asked for the code
		if (!answer.ok) throw new Error(`the sign-in code could not be sent (${answer.status})`);
	};
}
