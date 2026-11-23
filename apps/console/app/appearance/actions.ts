'use server';
// T-1022: the Appearance form's server action. It PATCHes /me/preferences as the signed-in member (their own bearer, no institution
// role needed), then re-renders every page so <html> carries the new attribute. A refusal changes nothing and shows the error line.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { memberApi } from '../../src/api.ts';
import { getConfig } from '../../src/config.ts';
import { requestContext } from '../../src/request.ts';
import { saveTheme } from '../../src/theme.ts';

export async function setTheme(formData: FormData): Promise<void> {
  const { access } = await requestContext();
  if (!access) redirect('/sign-in');
  const result = await saveTheme(memberApi(getConfig().CONSOLE_API_URL, access), formData.get('theme'));
  if (!result.ok) redirect('/appearance?error=1');
  revalidatePath('/', 'layout');
  redirect('/appearance?saved=1');
}
