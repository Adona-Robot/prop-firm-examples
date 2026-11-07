// Adona pushes an execution's confirmation as soon as it has it, and lists its effect (the
// position opened or closed, the order no longer resting) a moment later. So after an
// execution the page reads its lists at once, then again after each of `laterMs`; a new
// execution starts the reads over. Kept apart from app.js so the tests can run it.
export function relistAfterExecutions(relist, laterMs = [1000, 3000, 10_000]) {
  let pending = [];
  return () => {
    pending.forEach((id) => clearTimeout(id));
    relist();
    pending = laterMs.map((ms) => setTimeout(relist, ms));
  };
}
