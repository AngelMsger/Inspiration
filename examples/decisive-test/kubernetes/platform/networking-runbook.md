# Networking runbook

How the Platform team runs Service networking on our clusters, for the on-call engineer.

Last updated: 2026-08-04.

## LoadBalancer Services

- Each namespace gets at most 3 LoadBalancer Services; each one costs a cloud load balancer.
  Put several ports on one Service before asking for another.
- Internet-facing LoadBalancer Services set `externalTrafficPolicy: Local` (see the cluster
  standards). The cloud load balancer then health-checks each node and sends traffic only to
  nodes with a ready endpoint.
- Mixed protocols on one LoadBalancer Service (for example TCP and UDP on port 53) are an alpha
  feature since Kubernetes v1.20 and need the `MixedProtocolLBService` feature gate on the API
  server, which we do not enable. Create two Services instead.

## EndpointSlices

- EndpointSlices hold up to 1000 endpoints each, so a Service with fewer than 1000 ready Pods
  has a single EndpointSlice per address type.
- The `terminating` condition on an endpoint is a beta feature since Kubernetes v1.22. Do not
  build alerts on it yet; use `serving`.

## NetworkPolicy

- Targeting a range of ports with the `endPort` field is a beta feature since Kubernetes v1.22
  and needs the `NetworkPolicyEndPort` feature gate. List the ports one by one instead.
- Our network plugin enforces policies for TCP, UDP and SCTP.

## When a Service does not answer

1. Check that the Service's selector matches the Pod labels: `kubectl get endpointslices -l
   kubernetes.io/service-name=<name>`.
2. Check the NetworkPolicies in both namespaces.
3. Check kube-proxy's logs on the node of the client Pod.
