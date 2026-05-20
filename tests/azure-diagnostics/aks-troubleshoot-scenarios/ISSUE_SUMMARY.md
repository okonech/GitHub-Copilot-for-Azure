# AKS Troubleshooting Scenario Issue Summary

These fixtures are designed to stress-test diagnosis agents. Each prompt presents a realistic user-observed symptom and often includes a plausible but incomplete theory. The YAML intentionally layers primary blockers, secondary clues, and follow-on failures so an agent has to inspect evidence across pods, events, Services, endpoints, policies, storage, and workload specs.

## Cluster 1: `alexok-aks-diagnostics-1`

Cluster path: `subscriptions/ff05f55d-22b5-44a7-b704-f9a8efd493ed/resourceGroups/alexok-aks-diagnostics/providers/microsoft.containerservice/managedClusters/alexok-aks-diagnostics-1`

This cluster focuses on common workload configuration mistakes with extra misleading layers.

| Scenario | User-visible symptom | Layered issue summary |
| --- | --- | --- |
| `c1-liveness-wrong-path` | Pod restarts even though nginx responds on `/` while briefly running. | The liveness probe calls `/healthz`, which nginx does not serve. The same workload also has a Service with `targetPort: 8080`, so even after the restart issue is fixed, Service traffic would still miss the container's actual port. |
| `c1-bad-image-tag` | Pod is stuck in `ImagePullBackOff`. | The referenced MCR image tag does not exist. A missing `imagePullSecrets` reference adds a credential-looking clue that can distract from the exact pull error. |
| `c1-node-selector-missing` | Pod remains Pending and adding capacity does not help. | Scheduling is blocked by an impossible node selector and an impossible required zone affinity. A generic capacity diagnosis is incomplete. |
| `c1-catalog-api` | Service has no endpoints even though a catalog pod exists. | The Service selector points at `catalog-api-typo`, while the pod uses `catalog-api`. The pod also has a failing readiness probe, so agents must distinguish selector mismatch from readiness exclusion. |
| `c1-missing-env` | Container crashes at startup despite a related ConfigMap existing. | `APP_MODE` is supplied from `c1-missing-env-settings`, but the command also requires `DB_DSN`, which is not defined. Logs should identify the missing startup value. |
| `c1-frontend` | Service returns 503 while the container appears to run. | A bad readiness path prevents Ready endpoints. The Service also uses `targetPort: 8080` while nginx listens on port 80, so traffic would still fail after readiness is repaired. |
| `c1-orders-api` | Pod will not create a running container even though `c1-orders-config` exists. | The ConfigMap exists, but env references use singular key names. The ConfigMap defines `ORDERS_ENDPOINT` and `PAYMENTS_URL`, while the pod asks for `ORDER_ENDPOINT` and `PAYMENT_ENDPOINT`. |

## Cluster 2: `alexok-aks-diagnostics-2`

Cluster path: `subscriptions/ff05f55d-22b5-44a7-b704-f9a8efd493ed/resourceGroups/alexok-aks-diagnostics/providers/Microsoft.ContainerService/managedClusters/alexok-aks-diagnostics-2`

This cluster emphasizes ambiguous infrastructure-style failures across readiness, networking, storage, load balancing, and disruption policy.

| Scenario | User-visible symptom | Layered issue summary |
| --- | --- | --- |
| `c2-readiness-wrong-port` | Pod is Running but never Ready, and Service traffic also fails. | The readiness probe checks port 8080 while nginx listens on 80. The Service also targets 8080, creating a follow-on traffic bug after readiness is fixed. |
| `c2-memory-hog` | Pod keeps restarting, with later probe noise visible. | The first failure is OOMKilled because the container allocates far more memory than its 32Mi limit. A liveness probe can appear later and distract agents toward probe tuning. |
| `c2-net-client` and `c2-internal-api` | Client cannot reach the internal API. | The client pod has an egress-deny NetworkPolicy. The internal API also has a failing readiness probe that can remove endpoints, so the request path requires checking policy and endpoint readiness together. |
| `c2-internal-lb` | Internal LoadBalancer Service never receives an IP. | The Azure internal load balancer annotation references a missing subnet. The Service selector also points to `c2-lb-backend-typo`, so backend wiring remains wrong after the subnet problem is fixed. |
| `c2-pvc-consumer` | Pod is Pending with a PVC involved. | The PVC references a missing StorageClass, and the pod also has a node selector for a nonexistent storage node pool. Agents must order the storage and scheduling blockers rather than guessing node pressure. |
| `c2-dns-client` | Only this workload appears unable to resolve services. | The pod sets `dnsPolicy: None` with a bogus nameserver and also has a NetworkPolicy allowing only TCP port 80 egress. CoreDNS is not the only plausible explanation. |
| `c2-critical-api` | Node drain or upgrade is blocked around this workload. | The PDB requires `minAvailable: 2` with two replicas, leaving no voluntary disruption budget. Readiness failures further complicate available-pod math during eviction. |

## Cluster 3: `alexok-aks-diagnostics-3`

Cluster path: `subscriptions/ff05f55d-22b5-44a7-b704-f9a8efd493ed/resourceGroups/alexok-aks-diagnostics/providers/Microsoft.ContainerService/managedClusters/alexok-aks-diagnostics-3`

This cluster contains several cases where a related object exists but is not the object or relationship the workload actually needs.

| Scenario | User-visible symptom | Layered issue summary |
| --- | --- | --- |
| `c3-api` | Service has endpoints but callers get connection refused. | Endpoints rule out a selector-only diagnosis. The Service targets port 80 while the container serves on 8080. |
| `c3-dns-client` | Pod cannot resolve cluster services, tempting a CoreDNS restart. | DNS is broken at the pod level: `dnsPolicy: None`, bogus nameserver `203.0.113.10`, and a deny-all egress NetworkPolicy. |
| `c3-worker-no-cpu-request` | HPA will not scale a busy pod that has a CPU limit. | The HPA uses CPU utilization, but the container has no CPU request. A CPU limit is not enough for utilization-based HPA metrics. |
| `c3-secret-key-missing` | Container will not start even though a similar Secret exists. | `c3-app-secret` exists but only contains `wrong-token-key`, while the pod needs `token`. The pod also references a second missing Secret, `c3-missing-secret`. |
| `c3-too-large-to-schedule` | Pod is Pending and appears to need a bigger node pool. | The pod requests extreme CPU and memory and also has a node selector for a nonexistent oversized SKU. The scheduler has multiple independent reasons to reject placement. |
| `c3-slow-start` | App never gets past init although the dependency Service name exists. | The init container waits on `missing-backend`. The Service exists, but its selector points at no matching backend endpoints, so the dependency is not reachable. |
| `c3-service-account-api` | ReplicaSet cannot create pods even though related identity/RBAC objects exist. | A plausible `c3-api-runner` ServiceAccount and RoleBinding exist, but the pod references `c3-missing-service-account`. Pod creation fails before that RBAC setup can help. |

## Diagnosis Expectations

A strong agent response should:

- Use runtime evidence such as pod state, events, endpoints, and object specs before recommending fixes.
- Separate the first blocker from secondary or follow-on failures.
- Avoid accepting the user's suspected cause without checking it.
- Identify exact mismatches in names, selectors, ports, keys, probes, policies, storage classes, and service accounts.
- Explain the causal chain from configuration to symptom.