// api.js - Auth and User API helpers

export async function fetchUserInfo(token) {
    if (!token) return null;
    try {
        const resp = await fetch('/api/v1/user/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (resp.ok) return await resp.json();
    } catch (e) {
        console.error("[API] Failed to fetch user info:", e);
    }
    return null;
}

export async function fetchCombinedUserInfo(token, authClient) {
    // Optionally fetch both Propel and backend info
    const dbUserData = await fetchUserInfo(token);
    let propelUserInfo = null;
    if (authClient && authClient.getUser) {
        try {
            propelUserInfo = await authClient.getUser();
        } catch {}
    }
    return { dbUserData, propelUserInfo };
}
