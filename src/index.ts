#!/usr/bin/env node

import { GetAssetProofRpcResponse } from '@metaplex-foundation/digital-asset-standard-api';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { publicKey, publicKeyBytes, PublicKey } from '@metaplex-foundation/umi';
import {
  fetchTreeConfig,
  findLeafAssetIdPda,
  findTreeConfigPda,
  mplBubblegum,
} from '@metaplex-foundation/mpl-bubblegum';
import {
  MerkleTree,
  type MerkleTreeProof,
} from '@solana/spl-account-compression';
import * as cliProgress from 'cli-progress';
import * as fs from 'fs';
import { InvalidArgumentError, program } from '@commander-js/extra-typings';
import { RateLimiter } from 'limiter';
import path from 'node:path';

type Endpoint = {
  url: string;
  name: string;
};

function parsePubkey(input: string): PublicKey {
  try {
    return publicKey(input);
  } catch (e) {
    throw new InvalidArgumentError(String(e));
  }
}

const ENDPOINT_DESCRIPTION =
  'Each endpoint must be passed in as `<label>,<url>`, separated by a single comma bar.';

function parseEndpoint(
  input: string,
  prev: Endpoint[] | undefined
): Endpoint[] {
  const split = input.split(',');

  if (split.length !== 2) {
    throw new InvalidArgumentError(ENDPOINT_DESCRIPTION);
  }
  const url = split[1];
  if (!/^https?:/.test(url)) {
    throw new InvalidArgumentError(
      'Endpoint URL must start with `http:` or `https:`.'
    );
  }

  return (prev ?? []).concat({
    name: split[0],
    url: url,
  });
}

function parseRateLimit(value: string) {
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new InvalidArgumentError('Not a number.');
  }
  return parsedValue;
}
function parseUrl(value: string) {
  const url = value;
  if (!/^https?:/.test(url)) {
    throw new InvalidArgumentError(
      'Endpoint URL must start with `http:` or `https:`.'
    );
  }
  return value;
}

async function main() {
  program
    .requiredOption(
      '-t, --tree <tree key>',
      'The merkle tree Pubkey to validate proofs for',
      parsePubkey
    )
    .requiredOption(
      '-e, --endpoint <label,url...>',
      `A list of endpoints to check. ${ENDPOINT_DESCRIPTION}`,
      parseEndpoint
    )
    .requiredOption(
      '-c, --rpc <url>',
      `An RPC url`,
      parseUrl
    )
    .option(
      '-r, --rate-limit <number...>',
      'How many requests to send to each endpoint per second',
      parseRateLimit,
      1
    )
    .option(
      '-o, --output-folder <folder>',
      'Which folder to write the invalid proof files to',
      (input: string) => path.resolve(process.cwd(), input),
      path.join(process.cwd(), 'invalid-proofs')
    )
    .option(
      '-f, --force',
      'Whether to allow writing (and potentially overwriting) to the output-folder if it already exists',
      false
    )
    .action(async ({ tree, endpoint, rpc, rateLimit, outputFolder, force }) => {
      await run(tree, endpoint, rpc, rateLimit, outputFolder, force);
    });
  await program.parseAsync(process.argv);
}

async function run(
  treeKey: PublicKey,
  endpoints: Endpoint[],
  rpcUrl: string,
  rateLimit: number,
  proofDir: string,
  force: boolean
): Promise<void> {
  if (fs.existsSync(proofDir) && !force) {
    console.error(
      `Proof folder ${proofDir} already exists and \`--force\` wasn't passed in.`
    );
    process.exit(1);
  }
  fs.mkdirSync(proofDir, { recursive: true });

  const rpc = createUmi(rpcUrl, { commitment: 'confirmed' });
  const umis = endpoints.map((endpoint) =>
    createUmi(endpoint.url, {
      commitment: 'confirmed',
    }).use(mplBubblegum())
  );

  const treeConfigPda = findTreeConfigPda(rpc, {
    merkleTree: treeKey,
  });
  const treeConfig = await fetchTreeConfig(rpc, treeConfigPda);


  const multiBar = new cliProgress.MultiBar({});
  const validBars = endpoints.map((endpoint) =>
    multiBar.create(0, 0, undefined, {
      format: `${endpoint.name} Valid Proofs: {value} / {total}`,
    })
  );
  const updateBar = multiBar.create(
    Number(treeConfig.numMinted),
    0,
    {
      customEta: 0,
    },
    {
      format:
        'Progress [{bar}] {percentage}% | ETA: {customEta}s | {value}/{total}',
    }
  );

  const startTime = Date.now();
  const updateEta = () => {
    // calculate better ETA
    const elapsedTime = Date.now() - startTime;
    // value isn't exposed :/
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    const progress = updateBar.value;
    const timePerJob = elapsedTime / progress;
    const remainingJobs = updateBar.getTotal() - progress;
    updateBar.update({
      customEta: Math.ceil((remainingJobs * timePerJob) / 1000),
    });
  };

  const checkLeaf = async (leafIndex: number) => {
    const assetId = findLeafAssetIdPda(umis[0], {
      merkleTree: treeKey,
      leafIndex,
    })[0];
    const proofs = await Promise.all(
      umis.map(async (umi) => {
        try {
          return await umi.rpc.getAssetProof(assetId);
        } catch (e) {
          if (e instanceof Error) {
            return e.toString();
          }
          return JSON.stringify(e);
        }
      })
    );
    const proofValidities = proofs.map(verifyProof);
    let allValid = true;
    proofValidities.forEach((valid, index) => {
      if (valid !== true) {
        allValid = false;
      }
      if (valid !== null) {
        validBars[index].setTotal(validBars[index].getTotal() + 1);
        if (valid) {
          validBars[index].increment();
        }
      }
    });

    if (!allValid) {
      const comparison = {
        assetId,
        ...Object.fromEntries(
          proofs.map((proof, j) => [
            endpoints[j].name,
            {
              proof,
              valid: proofValidities[j],
            },
          ])
        ),
      };
      fs.writeFileSync(
        path.join(proofDir, `${leafIndex}.json`),
        JSON.stringify(comparison, null, 2)
      );
    }
    updateBar.increment();
    updateEta();
  };

  const limiter = new RateLimiter({
    tokensPerInterval: rateLimit,
    interval: 'second',
  });

  for (let leafIndex = 0; leafIndex < treeConfig.numMinted; leafIndex++) {
    await limiter.removeTokens(1);
    checkLeaf(leafIndex).catch((e) => {
      // this shouldn't error out
      console.error(e);
    });
  }
}

function verifyProof(
  proofRes: GetAssetProofRpcResponse | string
): boolean | null {
  if (typeof proofRes === 'string') {
    return null;
  }
  const root = Buffer.from(publicKeyBytes(proofRes.root));
  const proof: MerkleTreeProof = {
    root,
    leaf: Buffer.from(publicKeyBytes(proofRes.leaf)),
    leafIndex: proofRes.node_index,
    proof: proofRes.proof.map((key) => Buffer.from(publicKeyBytes(key))),
  };
  return MerkleTree.verify(root, proof);
}

main().catch((err) => {
  console.error(err);
});
