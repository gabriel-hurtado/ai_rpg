// api.js - Auth and User API helpers

export async function fetchUserInfo(token) {
  if (!token) return null;

  try {
    const response = await fetch('/api/v1/user/me', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) return response.json();
  } catch (error) {
    console.error('[API] Failed to fetch user info:', error);
  }

  return null;
}

export async function fetchCombinedUserInfo(token, authClient) {
  const dbUserData = await fetchUserInfo(token);
  const propelUserInfo = authClient?.getUser?.();

  return { dbUserData, propelUserInfo };
}
