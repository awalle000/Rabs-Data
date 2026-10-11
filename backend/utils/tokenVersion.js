export const tokenVersionMatches = (tokenVersion, userVersion) =>
  Number(tokenVersion ?? 0) === Number(userVersion ?? 0);