// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// The tenant fence: proves one organisation cannot see or change another's data.
// It creates two throwaway organisations through the real API, builds the same
// structure in each (departments, accounts, events, a payment sheet), and then has
// every account of organisation A try to reach organisation B's things. Anything
// other than a refusal is a failure.
//
// Run it against a TEST database only; it leaves its data behind. Start the server
// with LOGIN_RATE_LIMIT=100, because it signs in more than ten times from one place.
//
//   BASE_URL=http://localhost:3000 OWNER_EMAIL=... OWNER_PASSWORD=... node scripts/tenant-fence-check.js
//
// Exit code 0 means every attempt was refused.

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const OWNER_EMAIL = process.env.OWNER_EMAIL;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;
if (!OWNER_EMAIL || !OWNER_PASSWORD) {
  console.error('Set OWNER_EMAIL and OWNER_PASSWORD (the platform owner of the test database).');
  process.exit(2);
}

const stamp = Date.now().toString(36);
const PASSWORD = 'Fence#Check-12345';
let checks = 0;
const failures = [];

// A tiny client that keeps its own cookies, so each account has its own session.
function client() {
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(BASE + '/api' + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), patch: (p, b) => call('PATCH', p, b || {}), put: (p, b) => call('PUT', p, b || {}), del: (p) => call('DELETE', p) };
}

function expect(label, ok, detail) {
  checks += 1;
  if (!ok) {
    failures.push(`${label}${detail ? ' -- ' + detail : ''}`);
    console.log(`  FAIL  ${label}${detail ? ' -- ' + detail : ''}`);
  }
}
const refused = (r) => r.status === 401 || r.status === 403 || r.status === 404 || (r.data && r.data.ok === false);
const notFoundOrRefused = (r) => r.status === 403 || r.status === 404 || r.status === 400 || (r.data && r.data.ok === false);

async function login(email) {
  const c = client();
  const r = await c.post('/auth/login', { email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return c;
}
async function activate(url, password) {
  const token = decodeURIComponent(new URL(url).searchParams.get('token'));
  const r = await client().post('/auth/activate/' + encodeURIComponent(token), { password });
  if (!r.data || !r.data.ok) throw new Error('activation failed: ' + JSON.stringify(r.data));
}

// One organisation with a department, a super admin, a county admin (preparer), an
// authorising officer, and a payment sheet with one person on it.
async function build(owner, tag) {
  const name = `Fence ${tag} ${stamp}`;
  const created = await owner.post('/owner/organisations', { name, adminEmail: `org.${tag}.${stamp}@fence.test` });
  if (!created.data.ok) throw new Error('could not create organisation: ' + JSON.stringify(created.data));
  await activate(created.data.activationUrl, PASSWORD);
  const orgAdmin = await login(`org.${tag}.${stamp}@fence.test`);

  const dep = await orgAdmin.post('/platform/departments', { name: `Dept ${tag} ${stamp}` });
  const sa = await orgAdmin.post('/platform/super-admins', { email: `sa.${tag}.${stamp}@fence.test`, departmentId: dep.data.department.id });
  const saLink = await orgAdmin.post(`/platform/super-admins/${sa.data.admin.id}/activation-link`);
  await activate(saLink.data.url, PASSWORD);
  const superAdmin = await login(`sa.${tag}.${stamp}@fence.test`);

  const mk = async (suffix, county, access, paymentRole) => {
    const a = await superAdmin.post('/superadmin/admins', { email: `${suffix}.${tag}.${stamp}@fence.test`, county, access, paymentRole });
    const l = await superAdmin.post(`/superadmin/admins/${a.data.admin.id}/activation-link`);
    await activate(l.data.url, PASSWORD);
    return { id: a.data.admin.id, client: await login(`${suffix}.${tag}.${stamp}@fence.test`) };
  };
  const prep = await mk('prep', 'Mombasa', 'BOTH', 'PREPARER');
  const auth = await mk('auth', 'Kisumu', 'PAYMENT', 'AUTHORISER');

  const t0 = new Date(Date.now() + 60 * 1000);
  const t1 = new Date(t0.getTime() + 8 * 3600 * 1000);
  const base = { timezone: 'Africa/Nairobi', startAt: t0.toISOString(), endAt: t1.toISOString(), locationType: 'PHYSICAL', address: 'Somewhere' };
  const att = await prep.client.post('/admin/events', { ...base, name: `Attendance ${tag}` });
  const duty = await prep.client.post('/admin/events', {
    ...base,
    kind: 'DUTY_ROLL',
    name: `Duty ${tag}`,
    authorisedBy: 'Director',
    authorityRef: 'REF/1',
    days: [{ startAt: t0.toISOString(), endAt: t1.toISOString(), place: 'Mombasa' }]
  });
  await prep.client.post(`/admin/events/${duty.data.event.id}/duty/payees`, { name: 'Test Person', payeeType: 'STAFF', idNumber: `S${tag}${stamp}`.slice(0, 12), phone: '07' + String(Math.floor(10000000 + Math.random() * 89999999)), ratePerDay: 5000 });
  return { org: created.data.organisation, orgAdmin, dep: dep.data.department, sa: sa.data.admin, superAdmin, prep, auth, att: att.data.event, duty: duty.data.event };
}

async function main() {
  const owner = client();
  const o = await owner.post('/auth/login', { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  if (o.status !== 200 || o.data.user.role !== 'OWNER') throw new Error('The owner login failed. Is this the platform owner account?');

  console.log('Building two organisations...');
  const A = await build(owner, 'a');
  const B = await build(owner, 'b');

  console.log('Organisation A reaching for organisation B...');

  // The organisation admin
  const deps = await A.orgAdmin.get('/platform/departments');
  expect('org admin A lists only its own departments', deps.data.departments.every((d) => d.id !== B.dep.id) && deps.data.departments.some((d) => d.id === A.dep.id));
  expect("org admin A cannot rename B's department", refused(await A.orgAdmin.patch(`/platform/departments/${B.dep.id}`, { name: 'Hijacked' })));
  expect("org admin A cannot pause B's department", refused(await A.orgAdmin.patch(`/platform/departments/${B.dep.id}`, { active: false })));
  expect("org admin A cannot appoint a super admin into B's department", refused(await A.orgAdmin.post('/platform/super-admins', { email: `x.${stamp}@fence.test`, departmentId: B.dep.id })));
  const sas = await A.orgAdmin.get('/platform/super-admins');
  expect('org admin A lists none of B\'s super admins', sas.data.admins.every((a) => a.id !== B.sa.id));
  expect("org admin A cannot disable B's super admin", refused(await A.orgAdmin.post(`/platform/super-admins/${B.sa.id}/disable`)));
  expect("org admin A cannot get B's super admin's activation link", refused(await A.orgAdmin.post(`/platform/super-admins/${B.sa.id}/activation-link`)));
  expect("org admin A cannot delete B's super admin", refused(await A.orgAdmin.del(`/platform/super-admins/${B.sa.id}`)));
  const aud = await A.orgAdmin.get('/platform/audit?pageSize=100');
  expect('org admin A sees none of B\'s audit entries', aud.data.entries.every((e) => !e.actor || !String(e.actor.email).includes(`.b.${stamp}@`)));
  expect('org admin A cannot use the owner console', refused(await A.orgAdmin.get('/owner/organisations')));

  // The department super admin
  const adm = await A.superAdmin.get('/superadmin/admins');
  expect('super admin A lists none of B\'s admins', adm.data.admins.every((a) => a.id !== B.prep.id && a.id !== B.auth.id));
  expect("super admin A cannot disable B's admin", refused(await A.superAdmin.post(`/superadmin/admins/${B.prep.id}/disable`)));
  expect("super admin A cannot change B's admin access", refused(await A.superAdmin.patch(`/superadmin/admins/${B.prep.id}/access`, { access: 'ATTENDANCE' })));
  expect("super admin A cannot read B's admin audit", refused(await A.superAdmin.get(`/superadmin/admins/${B.prep.id}/audit`)));
  expect('super admin A cannot use the platform routes', refused(await A.superAdmin.get('/platform/departments')));

  // The county admins
  for (const [who, c] of [['preparer A', A.prep.client], ['authoriser A', A.auth.client]]) {
    expect(`${who} cannot read B's attendance sheet`, notFoundOrRefused(await c.get(`/admin/events/${B.att.id}/attendance`)));
    expect(`${who} cannot read B's payment sheet`, notFoundOrRefused(await c.get(`/admin/events/${B.duty.id}/duty`)));
    expect(`${who} cannot edit B's event`, notFoundOrRefused(await c.put(`/admin/events/${B.att.id}`, { name: 'Hijacked' })));
    expect(`${who} cannot delete B's event`, notFoundOrRefused(await c.del(`/admin/events/${B.att.id}`)));
    expect(`${who} cannot export B's payment schedule`, notFoundOrRefused(await c.get(`/admin/events/${B.duty.id}/duty/export.csv`)));
    expect(`${who} cannot add people to B's payment sheet`, notFoundOrRefused(await c.post(`/admin/events/${B.duty.id}/duty/payees`, { name: 'Intruder', payeeType: 'STAFF', idNumber: 'INTRUDER1', phone: '0700123456', ratePerDay: 1 })));
  }
  const pub = await A.prep.client.get(`/events/${B.att.slug}`);
  expect("preparer A does not get management rights over B's event link", !pub.data || pub.data.canManage !== true);
  expect("preparer A cannot edit B's attendee details", refused(await A.prep.client.patch(`/events/${B.att.slug}/attendance/none/admin-edit`, { phone: '0711111111' })));

  // Approvals
  expect("authoriser A cannot open B's sheet for review", notFoundOrRefused(await A.auth.client.get(`/duty-review/sheets/${B.duty.id}`)));
  const q = await A.auth.client.get('/duty-review/queue');
  expect("authoriser A's queue holds none of B's sheets", !q.data.sheets || q.data.sheets.every((s) => s.id !== B.duty.id));
  expect("authoriser A cannot certify B's sheet", notFoundOrRefused(await A.auth.client.post(`/duty-review/sheets/${B.duty.id}/certify`, { acknowledge: true })));

  // Branding: an organisation changes only its own look
  const bBefore = await client().get(`/branding?org=${B.org.slug}`);
  const aSet = await A.orgAdmin.put('/platform/branding', { displayName: 'Fence A Renamed', accentColor: '#006633' });
  expect('org admin A can restyle its own organisation', aSet.data && aSet.data.ok === true);
  const bAfter = await client().get(`/branding?org=${B.org.slug}`);
  expect("A's branding change does not touch B's look", bAfter.data.orgName === bBefore.data.orgName && bAfter.data.accent === bBefore.data.accent);
  expect("B's signed-in pages still show B's name", (await B.orgAdmin.get('/branding')).data.orgName === bBefore.data.orgName);
  expect('the owner cannot be reached through the branding routes of an org admin', refused(await owner.get('/platform/branding')));

  // The owner sees counts only
  const list = await owner.get('/owner/organisations');
  const text = JSON.stringify(list.data);
  expect('the owner console lists both organisations', list.data.organisations.some((x) => x.id === A.org.id) && list.data.organisations.some((x) => x.id === B.org.id));
  expect('the owner console carries no attendee or event details', !/Test Person|Attendance a|Duty a/.test(text));

  // Suspension
  console.log('Suspending organisation B...');
  expect('suspending needs a reason', refused(await owner.post(`/owner/organisations/${B.org.id}/suspend`, {})));
  expect('owner can suspend B', (await owner.post(`/owner/organisations/${B.org.id}/suspend`, { reason: 'fence check' })).data.ok === true);
  expect("B's existing session ends", (await B.superAdmin.get('/auth/me')).status === 401);
  const relog = await client().post('/auth/login', { email: `prep.b.${stamp}@fence.test`, password: PASSWORD });
  expect("B's people cannot log back in", relog.status === 403 && relog.data.error === 'ORGANISATION_SUSPENDED');
  expect("A is unaffected by B's suspension", (await A.superAdmin.get('/auth/me')).status === 200);
  expect('owner can resume B', (await owner.post(`/owner/organisations/${B.org.id}/resume`)).data.ok === true);
  expect('B can log in again', (await client().post('/auth/login', { email: `prep.b.${stamp}@fence.test`, password: PASSWORD })).status === 200);

  console.log(`\n${checks} attempts made, ${failures.length} not refused.`);
  if (failures.length) {
    console.log('\nThe fence has holes:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('Every attempt was refused.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
