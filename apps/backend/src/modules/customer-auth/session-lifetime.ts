/** How long a session may go unrefreshed before its row is pruned.
 *
 * Longer than any refresh token lives (`CUSTOMER_JWT_REFRESH_TTL`,
 * default 7d), so a row this idle cannot belong to a token that still
 * works. Raise it if that TTL is ever set past it: pruning a live
 * session would sign that device out.
 *
 * Its own file because two modules read it: customer-auth prunes the
 * session rows, and protocol-users reclaims the device credentials of
 * sessions this idle (see `ProtocolUsersService.sweepDeadSessionCredentials`). */
export const SESSION_IDLE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
