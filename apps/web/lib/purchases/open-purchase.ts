/**
 * Where a dialog's *Back to purchase* / *Open purchase* action shows (#1505). The receive and link dialogs
 * open both on the purchase's own page and elsewhere (*Pending units*, the Assets list, an asset's page).
 * On the purchase's page a link to it is a soft navigation to the URL already shown: the page stays
 * mounted, and so does the dialog, which lives in its state — the link does nothing. There the action is
 * not offered (*Done* already returns to the purchase, refreshed by the mutation); anywhere else it links.
 */

/** Whether `pathname` is the page of the purchase `purchaseId` itself (not its edit or review pages). */
export function isPurchasePage(pathname: string | null, purchaseId: string): boolean {
  return pathname === `/purchases/${purchaseId}`;
}
