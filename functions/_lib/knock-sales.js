// Sales from the door (completed in the sales build step). Until then a sale event is refused,
// so nothing reaches storage without the checklist and the cancellation deadline.
export async function validateSaleEvent() {
  return { status: 'rejected', code: 'knock_sales_unavailable', error: 'Sales open in the next update.' };
}

export async function applySaleEvent() {
  return [];
}
