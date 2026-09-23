// Owner-authorized named invitation. This is an invitation grant, not an active
// login. Account activation requires the private 256-bit token and saves one
// encrypted employee account atomically. No public provision action exists.
// Only the token's SHA-256 digest is stored in source; never the bearer token.
export const STAFF_INVITATIONS=Object.freeze([Object.freeze({id:'zoe-zoll-20260923',username:'zoe.zoll',firstName:'Zoe',lastName:'Zoll',email:'zoe.zoll@easygaragecleaning.com',role:'sales',approvedBy:'zacb',tokenHash:'f52f970976664bdbe2640081d4c65cc460fc19b4bef3755c88aac998a9873ac5',expiresAt:'2026-09-25T18:23:57.895Z',createdAt:'2026-09-23T18:23:57.895Z'})]);
