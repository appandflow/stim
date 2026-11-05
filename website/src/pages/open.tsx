import Head from '@docusaurus/Head';
import Layout from '@theme/Layout';
import { useEffect, useState } from 'react';
import { parseWorkspaceLink, sharedWorkspaceURL } from '../../../packages/core/workspace-link';

export default function OpenWorkspace() {
  const [links, setLinks] = useState<{ desktop: string; mobile: string } | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const destination = parseWorkspaceLink(window.location.href);
    if (destination) {
      const query = new URL(sharedWorkspaceURL(destination)).search;
      setLinks({ desktop: `stim-desktop://shared${query}`, mobile: `stim://open${query}` });
    }
    setChecked(true);
  }, []);
  return (
    <Layout title="Open in Stim" description="Open a shared workspace in the Stim app.">
      <Head>
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <main className="container margin-vert--xl">
        <h1>Open in Stim</h1>
        {links ? (
          <>
            <p>This link opens a workspace in Stim. If the app didn&apos;t open, choose your device below.</p>
            <p>
              <a className="button button--primary margin-right--md" href={links.desktop}>
                Open on this Mac
              </a>
              <a className="button button--secondary" href={links.mobile}>
                Open on iPhone or iPad
              </a>
            </p>
            <p>Install or update Stim, then open this link again.</p>
            <a href="/">Get Stim</a>
          </>
        ) : (
          <p>{checked ? 'This workspace link is incomplete or unsupported.' : 'Checking workspace link...'}</p>
        )}
      </main>
    </Layout>
  );
}
