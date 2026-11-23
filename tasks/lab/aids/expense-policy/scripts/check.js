// Check an expense against the policy table in SKILL.md (offline; no API calls).
const LIMITS = { Meals: 75, Travel: 1000, Software: 300, Hardware: 150, Training: 500, 'Office supplies': 100 };
function checkExpense({ category, amount }) {
  const limit = LIMITS[category];
  if (limit == null) return { ok: false, reason: `unknown category ${category}` };
  return amount <= limit ? { ok: true, reason: 'within policy' } : { ok: false, reason: `over the ${category} limit of $${limit}; needs approval` };
}
