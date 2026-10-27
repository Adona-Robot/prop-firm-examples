// THE DEMO SIGN-IN. Replace it with yours before anyone but you uses this.
//
// It signs in by user name alone, with no password: good for trying the example on your
// own machine, and for nothing else. That is why the server refuses to start on any
// address other than this machine's own.
//
// What to keep when you replace it: your user is matched to YOUR trader by your own name
// of them, the `external_ref` you set when you invited them on `/v1/prop/traders`. The
// server then acts for that trader only, whatever the browser sends.

const LOCAL = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertLocalOnly(host) {
  if (!LOCAL.has(host)) {
    throw new Error(`the DEMO sign-in serves this machine only (HOST=${host}); replace demo-login.mjs with your own sign-in first`);
  }
}

// DEMO_USERS="alice:your-ref-for-alice,bob:your-ref-for-bob": user name -> external_ref.
export function demoUsers(spec = "") {
  const users = new Map();
  for (const pair of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [user, ref] = pair.split(":");
    if (user && ref) users.set(user, ref);
  }
  if (users.size === 0) throw new Error('set DEMO_USERS="alice:<external_ref>,bob:<external_ref>"');
  return users;
}
